const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');

// GET /api/reports/:sessionId
// Returns the session report + supporting data for the report page
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [sessionResult, scoresResult, transcriptsResult] = await Promise.all([
      supabase.from('sessions').select('*').eq('id', id).single(),
      supabase.from('scores').select('*').eq('session_id', id),
      supabase.from('transcripts').select('*').eq('session_id', id).order('timestamp_seconds'),
    ]);

    if (sessionResult.error) throw sessionResult.error;

    const session = sessionResult.data;

    if (!session.report) {
      return res.status(404).json({ error: 'Report not yet generated for this session' });
    }

    res.json({
      report: session.report,
      session: {
        id: session.id,
        title: session.title,
        topic: session.topic,
        status: session.status,
        started_at: session.started_at,
        ended_at: session.ended_at,
        group_name: session.group_name,
      },
      scores: scoresResult.data || [],
      transcripts: transcriptsResult.data || [],
    });

  } catch (err) {
    console.error('[Reports] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
