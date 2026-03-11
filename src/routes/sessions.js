const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { startTranscription, stopTranscription, getSessionStats } = require('../services/transcription');
const { generatePostSessionReport } = require('../services/scoring');

// Create a new session
router.post('/', async (req, res) => {
  try {
    const { title, topic, createdBy, scoringWeights, group_name } = req.body;
    if (!title || !topic) return res.status(400).json({ error: 'title and topic are required' });

    const weights = scoringWeights || {
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
    }).select().single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('[Sessions] Create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get all sessions
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

// Get single session
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

// Start a session
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

    await startTranscription(id, session.topic);
    res.json({ success: true, message: 'Session started' });
  } catch (err) {
    console.error('[Sessions] Start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// End a session + generate report
router.post('/:id/end', async (req, res) => {
  const { id } = req.params;
  console.log(`[Sessions] Ending session ${id}`);

  try {
    // 1. Stop transcription (safe even if already stopped)
    try {
      await stopTranscription(id);
    } catch (err) {
      console.warn('[Sessions] stopTranscription error (non-fatal):', err.message);
    }

    // 2. Fetch all session data — each query independent so one failure doesn't block others
    const [transcriptResult, scoresResult, materialsResult, sessionResult] = await Promise.all([
      supabase.from('transcripts').select('*').eq('session_id', id).order('timestamp_seconds'),
      supabase.from('scores').select('*').eq('session_id', id),
      supabase.from('materials').select('*').eq('session_id', id),
      supabase.from('sessions').select('*').eq('id', id).single(),
    ]);

    // Log any fetch errors but don't crash
    if (transcriptResult.error) console.warn('[Sessions] Transcripts fetch error:', transcriptResult.error.message);
    if (scoresResult.error) console.warn('[Sessions] Scores fetch error:', scoresResult.error.message);
    if (materialsResult.error) console.warn('[Sessions] Materials fetch error:', materialsResult.error.message);
    if (sessionResult.error) {
      console.error('[Sessions] Session fetch error:', sessionResult.error.message);
      throw new Error('Session not found: ' + sessionResult.error.message);
    }

    const session = sessionResult.data;
    const transcripts = transcriptResult.data || [];
    const scores = scoresResult.data || [];
    const materials = materialsResult.data || [];

    console.log(`[Sessions] Data fetched — transcripts:${transcripts.length} scores:${scores.length} materials:${materials.length}`);

    // 3. Build scores map
    const scoresMap = {};
    scores.forEach(s => {
      scoresMap[s.speaker_tag] = {
        participation: s.participation_score,
        topic_adherence: s.topic_adherence_score,
        depth: s.depth_score,
        material_application: s.material_application_score,
        overall: s.overall_score,
        bloom_level: s.bloom_level || 'REMEMBER',
      };
    });

    // 4. Generate report — has its own internal try/catch, will never throw
    console.log(`[Sessions] Generating report for session ${id}`);
    const report = await generatePostSessionReport({
      sessionId: id,
      topic: session.topic || 'General discussion',
      transcripts,
      scores: scoresMap,
      materials,
    });
    console.log(`[Sessions] Report generated successfully`);

    // 5. Save report + mark session complete
    const { error: updateError } = await supabase.from('sessions').update({
      status: 'completed',
      ended_at: new Date().toISOString(),
      report: report,
    }).eq('id', id);

    if (updateError) {
      console.error('[Sessions] Failed to save report:', updateError.message);
      throw new Error('Failed to save report: ' + updateError.message);
    }

    console.log(`[Sessions] Session ${id} completed and report saved`);
    res.json({ success: true, report });

  } catch (err) {
    console.error('[Sessions] /end error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get live stats
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

// Admin issues a prompt
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

// Delete a session
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
