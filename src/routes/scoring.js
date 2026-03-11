const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');

// Get scores for a session
router.get('/:sessionId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('scores')
      .select('*')
      .eq('session_id', req.params.sessionId);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
