const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('../services/supabase');
const { startTranscription, stopTranscription, getSessionStats } = require('../services/transcription');
const { generatePostSessionReport } = require('../services/scoring');
const { retrieveRelevantChunks } = require('../services/rag');

// ─── Create a new session ─────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { title, topic, createdBy, scoringWeights, group_name, session_config } = req.body;
    if (!title || !topic) return res.status(400).json({ error: 'title and topic are required' });

    const weights = scoringWeights || session_config?.scoring_weights || {
      participation: 0.2, topic_adherence: 0.2, depth: 0.3, material_application: 0.3,
    };

    const { data, error } = await supabase.from('sessions').insert({
      title, topic,
      created_by: createdBy,
      scoring_weights: weights,
      status: 'pending',
      group_name: group_name || null,
      session_config: session_config || {},
    }).select().single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('[Sessions] Create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Update session config ────────────────────────────────────────────────────
router.patch('/:id/config', async (req, res) => {
  try {
    const { id } = req.params;
    const { session_config } = req.body;
    if (!session_config) return res.status(400).json({ error: 'session_config is required' });

    const { data: existing } = await supabase
      .from('sessions').select('session_config').eq('id', id).single();

    const merged = { ...(existing?.session_config || {}), ...session_config };

    const updatePayload = { session_config: merged };
    if (session_config.scoring_weights) {
      updatePayload.scoring_weights = session_config.scoring_weights;
    }

    const { data, error } = await supabase
      .from('sessions').update(updatePayload).eq('id', id).select().single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('[Sessions] Config update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Suggest discussion prompts from uploaded materials ───────────────────────
// Called from wizard Step 3 after materials are uploaded in Step 2.
// Auto-loads when professor arrives at Step 3 with materials present.
router.post('/:id/suggest-prompts', async (req, res) => {
  try {
    const { id } = req.params;
    const { topic, objectives, professorPrompts } = req.body;

    let chunks = [];
    try {
      chunks = await retrieveRelevantChunks(id, topic || 'discussion', 8);
    } catch (err) {
      console.warn('[SuggestPrompts] RAG failed:', err.message);
    }

    if (chunks.length === 0) {
      return res.json({
        suggestions: [],
        message: 'No materials found — upload PDFs first for content-grounded suggestions.',
      });
    }

    const materialContext = chunks.map((c, i) => `[${i+1}] ${c}`).join('\n\n');

    const professorPromptsText = (professorPrompts || [])
      .filter(p => p.trim())
      .map((p, i) => `${i+1}. ${p}`)
      .join('\n');

    const objectivesText = (objectives || [])
      .filter(o => o.trim())
      .map((o, i) => `${i+1}. ${o}`)
      .join('\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `You are an expert discussion facilitator designing prompts for a university-level academic discussion.

Session topic: ${topic || 'General academic discussion'}

${objectivesText ? `Learning objectives:\n${objectivesText}\n` : ''}
${professorPromptsText ? `Professor's own discussion prompts (use these as tone and style reference — do not repeat them):\n${professorPromptsText}\n` : ''}

Relevant course material:
${materialContext}

Generate 4-6 discussion prompts that:
1. Are directly grounded in the material above — reference specific concepts, frameworks, or cases from the text
2. Match the tone and cognitive level of the professor's prompts if provided
3. Force students to take a position or make a judgement — not just recall or summarise
4. Progress from accessible to challenging — build cognitive depth across the sequence
5. Align with the learning objectives if provided
6. Are phrased as questions a facilitator would ask mid-discussion, not essay prompts

Respond ONLY with valid JSON, no markdown:
{"suggestions":[{"prompt":"<discussion prompt text>","rationale":"<one sentence: why this prompt matters>","bloom_level":"<UNDERSTAND|APPLY|ANALYSE|EVALUATE|CREATE>"}]}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content?.[0]?.text?.trim();
    if (!text) throw new Error('Empty response from Claude');

    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    console.log(`[SuggestPrompts] Generated ${parsed.suggestions?.length || 0} suggestions for session ${id}`);
    res.json(parsed);

  } catch (err) {
    console.error('[SuggestPrompts] Error:', err.message);
    res.status(500).json({ error: err.message, suggestions: [] });
  }
});

// ─── Get all sessions ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sessions').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get single session ───────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [session, scores, materials] = await Promise.all([
      supabase.from('sessions').select('*').eq('id', id).single(),
      supabase.from('scores').select('*').eq('session_id', id),
      supabase.from('materials').select('id, file_name, uploaded_at').eq('session_id', id),
    ]);
    if (session.error) throw session.error;
    res.json({ ...session.data, scores: scores.data || [], materials: materials.data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start a session ──────────────────────────────────────────────────────────
router.post('/:id/start', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: session, error } = await supabase
      .from('sessions').select('*').eq('id', id).single();
    if (error) throw error;

    await supabase.from('sessions').update({
      status: 'active',
      started_at: new Date().toISOString(),
    }).eq('id', id);

    await startTranscription(id, session.topic, session.session_config);
    res.json({ success: true, message: 'Session started' });
  } catch (err) {
    console.error('[Sessions] Start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── End a session + generate report ─────────────────────────────────────────
router.post('/:id/end', async (req, res) => {
  const { id } = req.params;
  console.log(`[Sessions] Ending session ${id}`);

  try {
    try { await stopTranscription(id); } catch (err) {
      console.warn('[Sessions] stopTranscription error (non-fatal):', err.message);
    }

    const [transcriptResult, scoresResult, materialsResult, sessionResult] = await Promise.all([
      supabase.from('transcripts').select('*').eq('session_id', id).order('timestamp_seconds'),
      supabase.from('scores').select('*').eq('session_id', id),
      supabase.from('materials').select('*').eq('session_id', id),
      supabase.from('sessions').select('*').eq('id', id).single(),
    ]);

    if (transcriptResult.error) console.warn('[Sessions] Transcripts fetch error:', transcriptResult.error.message);
    if (scoresResult.error) console.warn('[Sessions] Scores fetch error:', scoresResult.error.message);
    if (materialsResult.error) console.warn('[Sessions] Materials fetch error:', materialsResult.error.message);
    if (sessionResult.error) throw new Error('Session not found: ' + sessionResult.error.message);

    const session = sessionResult.data;
    const transcripts = transcriptResult.data || [];
    const scores = scoresResult.data || [];
    const materials = materialsResult.data || [];

    console.log(`[Sessions] Data fetched — transcripts:${transcripts.length} scores:${scores.length} materials:${materials.length}`);

    const scoresMap = {};
    scores.forEach(s => {
      scoresMap[s.speaker_tag] = {
        topic_adherence: s.topic_adherence,
        depth: s.depth,
        material_application: s.material_application,
        overall: s.overall_score,
        bloom_level: s.bloom_level || 'REMEMBER',
      };
    });

    console.log(`[Sessions] Generating report for session ${id}`);
    const report = await generatePostSessionReport({
      sessionId: id,
      topic: session.topic || 'General discussion',
      transcripts, scores: scoresMap, materials,
      sessionConfig: session.session_config || {},
    });
    console.log(`[Sessions] Report generated successfully`);

    const { error: updateError } = await supabase.from('sessions').update({
      status: 'completed',
      ended_at: new Date().toISOString(),
      report,
    }).eq('id', id);

    if (updateError) throw new Error('Failed to save report: ' + updateError.message);
    res.json({ success: true, report });

  } catch (err) {
    console.error('[Sessions] /end error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Get live stats ───────────────────────────────────────────────────────────
router.get('/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;
    const [scores, transcriptCount] = await Promise.all([
      supabase.from('scores').select('*').eq('session_id', id),
      supabase.from('transcripts').select('id', { count: 'exact' }).eq('session_id', id),
    ]);
    res.json({
      scores: scores.data || [],
      utteranceCount: transcriptCount.count || 0,
      liveStats: getSessionStats(id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin issues a prompt ────────────────────────────────────────────────────
router.post('/:id/prompt', async (req, res) => {
  try {
    const { id } = req.params;
    const { target, prompt, type } = req.body;
    const { broadcastToSession, broadcastToAdmins } = require('../services/websocket');
    broadcastToSession(id, 'AI_PROMPT', { target, prompt, type, issuedBy: 'admin' });
    broadcastToAdmins(id, 'PROMPT_ISSUED', { target, prompt, type });
    await supabase.from('prompts_log').insert({
      session_id: id, target, prompt_text: prompt, prompt_type: type, issued_by: 'admin',
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk delete sessions ─────────────────────────────────────────────────────
router.delete('/bulk', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }

    for (const id of ids) {
      await Promise.all([
        supabase.from('transcripts').delete().eq('session_id', id),
        supabase.from('scores').delete().eq('session_id', id),
        supabase.from('prompts_log').delete().eq('session_id', id),
        supabase.from('document_chunks').delete().eq('session_id', id),
      ]);
      const { data: materials } = await supabase.from('materials').select('file_path').eq('session_id', id);
      if (materials?.length) {
        await supabase.storage.from('session-materials').remove(materials.map(m => m.file_path));
      }
      await supabase.from('materials').delete().eq('session_id', id);
      await supabase.from('sessions').delete().eq('id', id);
    }

    res.json({ success: true, deleted: ids.length });
  } catch (err) {
    console.error('[Sessions] Bulk delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete a session ─────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await Promise.all([
      supabase.from('transcripts').delete().eq('session_id', id),
      supabase.from('scores').delete().eq('session_id', id),
      supabase.from('prompts_log').delete().eq('session_id', id),
      supabase.from('document_chunks').delete().eq('session_id', id),
    ]);
    const { data: materials } = await supabase.from('materials').select('file_path').eq('session_id', id);
    if (materials?.length) {
      await supabase.storage.from('session-materials').remove(materials.map(m => m.file_path));
    }
    await supabase.from('materials').delete().eq('session_id', id);
    await supabase.from('sessions').delete().eq('id', id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
