const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');

// Get full report for a completed session
router.get('/:sessionId', async (req, res) => {
  try {
    const { data: session, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', req.params.sessionId)
      .single();
    if (error) throw error;
    if (!session.report) return res.status(404).json({ error: 'Report not yet generated' });

    const [transcripts, scores, materials] = await Promise.all([
      supabase.from('transcripts').select('*').eq('session_id', req.params.sessionId).order('timestamp_seconds'),
      supabase.from('scores').select('*').eq('session_id', req.params.sessionId),
      supabase.from('materials').select('id, file_name').eq('session_id', req.params.sessionId),
    ]);

    res.json({
      session: { id: session.id, title: session.title, topic: session.topic, started_at: session.started_at, ended_at: session.ended_at },
      report: session.report,
      scores: scores.data || [],
      transcripts: transcripts.data || [],
      materials: materials.data || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// Scoring routes
const scoringRouter = express.Router();

scoringRouter.get('/:sessionId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('scores').select('*').eq('session_id', req.params.sessionId);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports.scoringRouter = scoringRouter;
