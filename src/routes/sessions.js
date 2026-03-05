const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { startTranscription, stopTranscription, getSessionStats } = require('../services/transcription');
const { generatePostSessionReport } = require('../services/scoring');

// Create a new session
router.post('/', async (req, res) => {
  try {
    const { title, topic, createdBy, scoringWeights } = req.body;
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
    }).select().single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
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

// Get single session with participants, scores
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

// Start a session (begin transcription)
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
    res.json({ success: true, message: 'Session started, transcription active' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// End a session + generate report
router.post('/:id/end', async (req, res) => {
  try {
    const { id } = req.params;

    await stopTranscription(id);

    const [transcripts, scores, materials, session] = await Promise.all([
      supabase.from('transcripts').select('*').eq('session_id', id).order('timestamp_seconds'),
      supabase.from('scores').select('*').eq('session_id', id),
      supabase.from('materials').select('*').eq('session_id', id),
      supabase.from('sessions').select('*').eq('id', id).single(),
    ]);

    // Build scores map
    const scoresMap = {};
    (scores.data || []).forEach(s => {
      scoresMap[s.speaker_tag] = {
        participation: s.participation_score,
        topic_adherence: s.topic_adherence_score,
        depth: s.depth_score,
        material_application: s.material_application_score,
        overall: s.overall_score,
      };
    });

    // Generate AI report
    const report = await generatePostSessionReport({
      sessionId: id,
      topic: session.data.topic,
      transcripts: transcripts.data || [],
      scores: scoresMap,
      materials: materials.data || [],
    });

    // Save report + update session status
    await supabase.from('sessions').update({
      status: 'completed',
      ended_at: new Date().toISOString(),
      report: report,
    }).eq('id', id);

    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get live stats for admin dashboard
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

// Admin issues a prompt to a participant/group
router.post('/:id/prompt', async (req, res) => {
  try {
    const { id } = req.params;
    const { target, prompt, type } = req.body;
    const { broadcastToSession, broadcastToAdmins } = require('../services/websocket');

    // Broadcast prompt to all participants in session
    broadcastToSession(id, 'AI_PROMPT', { target, prompt, type, issuedBy: 'admin' });
    broadcastToAdmins(id, 'PROMPT_ISSUED', { target, prompt, type });

    // Log it
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

module.exports = router;
