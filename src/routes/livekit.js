const express = require('express');
const router = express.Router();
const { AccessToken } = require('livekit-server-sdk');

// Generate a LiveKit access token for a participant
router.post('/token', async (req, res) => {
  try {
    const { roomName, participantName, isAdmin } = req.body;
    if (!roomName || !participantName) {
      return res.status(400).json({ error: 'roomName and participantName are required' });
    }

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity: participantName, ttl: '4h' }
    );

    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      roomAdmin: isAdmin === true,
    });

    const token = await at.toJwt();
    res.json({ token, url: process.env.LIVEKIT_URL });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
