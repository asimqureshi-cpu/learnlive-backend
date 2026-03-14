const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { startTranscription, stopTranscription, getSessionStats } = require('../services/transcription');
const { generatePostSessionReport } = require('../services/scoring');

// ─── Create a new session ─────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { title, topic, createdBy, scoringWeights, group_name, session_config } = req.body;
    if (!title || !topic) return res.status(400).json({ error: 'title and topic are required' });

    // Legacy scoring_weights kept for backward compat;
    // new sessions use session_config.scoring_weights
    const weights = scoringWeights || session_config?.scoring_weights || {
      participation: 0.2,
      topic_adherence: 0.2,
      depth: 0.3,
      material_application: 0.3,
    };

    const { data, error } = await supabase.from('sessions').insert({
      title,
      topic,
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

// ─── Update session config (wizard final step or mid-setup edits) ─────────────
// PATCH /api/sessions/:id/config
router.patch('/:id/config', async (req, res) => {
  try {
    const { id } = req.params;
    const { session_config } = req.body;
    if (!session_config) return res.status(400).json({ error: 'session_config is required' });

    // Merge with existing config rather than overwrite
    const { data: existing } = await supabase
      .from('sessions').select('session_config').eq('id', id).single();

    const merged = { ...(existing?.session_config || {}), ...session_config };

    // Also sync scoring_weights column from config for backward compat
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

// ─── Get all sessions ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .order('created_at', { ascending: false });
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
    res.json({
      ...session.data,
      scores: scores.data || [],
      materials: materials.data || [],
    });
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
    try {
      await stopTranscription(id);
    } catch (err) {
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

    // Build scores map using correct column names
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
      transcripts,
      scores: scoresMap,
      materials,
      sessionConfig: session.session_config || {},
    });
    console.log(`[Sessions] Report generated successfully`);

    const { error: updateError } = await supabase.from('sessions').update({
      status: 'completed',
      ended_at: new Date().toISOString(),
      report: report,
    }).eq('id', id);

    if (updateError) throw new Error('Failed to save report: ' + updateError.message);

    console.log(`[Sessions] Session ${id} completed and report saved`);
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
      session_id: id,
      target,
      prompt_text: prompt,
      prompt_type: type,
      issued_by: 'admin',
    });

    res.json({ success: true });
  } catch (err) {
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
