const { WebSocketServer } = require('ws');
let wss;
const sessionClients = new Map();

// Per session: participantName -> { rms, smoothedRMS, manualOverride, lastUpdate }
const sessionRMS = new Map();
const activeSpeakers = new Map();
const speakerLockUntil = new Map(); // prevent rapid switching

const RMS_SILENCE_THRESHOLD = 0.010;   // below this = silence
const RMS_DOMINANCE_RATIO = 1.4;        // challenger needs 1.4x to take over (was 1.8 — too sticky)
const SPEAKER_LOCK_MS = 600;            // hold for 600ms min (was 800)
const RMS_SMOOTHING_RISING = 0.5;       // fast attack — react quickly when someone new speaks louder
const RMS_SMOOTHING_FALLING = 0.15;     // slow decay — don't drop out during natural pauses
const CURRENT_SPEAKER_SILENCE_MS = 800; // if current speaker silent this long, release lock immediately

function getSessionRMS(sessionId) {
  if (!sessionRMS.has(sessionId)) sessionRMS.set(sessionId, new Map());
  return sessionRMS.get(sessionId);
}

function electActiveSpeaker(sessionId) {
  const rmsMap = sessionRMS.get(sessionId);
  if (!rmsMap || rmsMap.size === 0) return null;

  const now = Date.now();
  const current = activeSpeakers.get(sessionId);
  const lockUntil = speakerLockUntil.get(sessionId) || 0;

  // Check for manual override first — always wins immediately
  for (const [name, data] of rmsMap.entries()) {
    if (data.manualOverride && now - data.lastUpdate < 1000) {
      if (name !== current) {
        console.log(`[RMS] Override → ${name}`);
        activeSpeakers.set(sessionId, name);
        speakerLockUntil.set(sessionId, now + SPEAKER_LOCK_MS);
      }
      return name;
    }
  }

  // Within speaker lock window — BUT release early if current speaker has gone silent
  if (now < lockUntil && current) {
    const currentData = rmsMap.get(current);
    const currentSilentFor = currentData ? now - currentData.lastUpdate : 999999;
    const currentRMS = currentData ? (currentData.smoothedRMS || 0) : 0;
    // Release lock early if current speaker has been silent for a sustained period
    if (currentRMS < RMS_SILENCE_THRESHOLD && currentSilentFor > CURRENT_SPEAKER_SILENCE_MS) {
      // Current speaker went quiet — allow challenger to take over
    } else {
      return current;
    }
  }

  // Find all active participants (not stale)
  const active = [];
  for (const [name, data] of rmsMap.entries()) {
    if (now - data.lastUpdate < 1200) {
      active.push({ name, rms: data.smoothedRMS || data.rms });
    }
  }

  if (active.length === 0) return current;
  if (active.length === 1) {
    const only = active[0];
    if (only.rms < RMS_SILENCE_THRESHOLD) return current;
    if (only.name !== current) {
      activeSpeakers.set(sessionId, only.name);
      speakerLockUntil.set(sessionId, now + SPEAKER_LOCK_MS);
    }
    return only.name;
  }

  // Sort by RMS descending
  active.sort((a, b) => b.rms - a.rms);
  const top = active[0];
  const second = active[1];

  // Must be above silence threshold
  if (top.rms < RMS_SILENCE_THRESHOLD) return current;

  // Must dominate second place by required ratio
  const ratio = second.rms > 0 ? top.rms / second.rms : 999;
  if (ratio < RMS_DOMINANCE_RATIO) {
    // Ambiguous — keep current speaker to avoid thrashing
    return current;
  }

  if (top.name !== current) {
    console.log(`[RMS] Speaker → ${top.name} (rms=${top.rms.toFixed(3)}, ratio=${ratio.toFixed(2)})`);
    activeSpeakers.set(sessionId, top.name);
    speakerLockUntil.set(sessionId, now + SPEAKER_LOCK_MS);
  }

  return top.name;
}

function initWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    const role = url.searchParams.get('role');
    const participantName = url.searchParams.get('participantName') || url.searchParams.get('participant') || 'unknown';
    const type = url.searchParams.get('type');

    ws._sessionId = sessionId;
    ws._role = role;
    ws._participantName = participantName;
    ws._type = type;

    if (type === 'audio') {
      const rmsMap = getSessionRMS(sessionId);
      rmsMap.set(participantName, { rms: 0, smoothedRMS: 0, manualOverride: false, lastUpdate: Date.now() });

      ws.on('message', (data, isBinary) => {
        if (!sessionId) return;
        const { sendAudioChunk } = require('./transcription');

        if (!isBinary) {
          // RMS control message
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'rms') {
              const rmsMap = getSessionRMS(sessionId);
              const existing = rmsMap.get(participantName) || { smoothedRMS: 0 };
              // Asymmetric smoothing: fast rise, slow fall — mimics natural speech envelope
              const rawRMS = msg.rms || 0;
              const alpha = rawRMS > (existing.smoothedRMS || 0) ? RMS_SMOOTHING_RISING : RMS_SMOOTHING_FALLING;
              const smoothed = (existing.smoothedRMS || 0) * (1 - alpha) + rawRMS * alpha;
              rmsMap.set(participantName, {
                rms: msg.rms || 0,
                smoothedRMS: smoothed,
                manualOverride: msg.manualOverride || false,
                lastUpdate: Date.now(),
              });
              electActiveSpeaker(sessionId);
            }
          } catch (e) {}
        } else {
          // PCM audio — only forward if this participant is active speaker
          const activeSpeaker = activeSpeakers.get(sessionId);

          // If no active speaker elected yet (session just started), allow through
          if (!activeSpeaker || activeSpeaker === participantName) {
            sendAudioChunk(sessionId, data, participantName);
          }
        }
      });

      ws.on('close', () => {
        console.log(`[Audio] Stream closed for ${participantName}`);
        const rmsMap = sessionRMS.get(sessionId);
        if (rmsMap) rmsMap.delete(participantName);
        // If this was the active speaker, clear it
        if (activeSpeakers.get(sessionId) === participantName) {
          activeSpeakers.delete(sessionId);
        }
      });

      ws.on('error', (e) => console.error('[Audio] Error:', e.message));
      ws.send(JSON.stringify({ event: 'AUDIO_CONNECTED' }));
      return;
    }

    if (sessionId) {
      if (!sessionClients.has(sessionId)) sessionClients.set(sessionId, new Set());
      sessionClients.get(sessionId).add(ws);
    }

    ws.on('close', () => {
      if (ws._sessionId && sessionClients.has(ws._sessionId)) {
        sessionClients.get(ws._sessionId).delete(ws);
      }
    });
    ws.on('error', console.error);
  });

  console.log('WebSocket server initialised');
}

function broadcastToSession(sessionId, event, data) {
  if (!sessionClients.has(sessionId)) return;
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  sessionClients.get(sessionId).forEach(c => { if (c.readyState === 1) c.send(message); });
}

function broadcastToAdmins(sessionId, event, data) {
  if (!sessionClients.has(sessionId)) return;
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  sessionClients.get(sessionId).forEach(c => {
    if (c.readyState === 1 && c._role === 'admin') c.send(message);
  });
}

function sendToParticipant(sessionId, participantName, event, data) {
  if (!sessionClients.has(sessionId)) return;
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  sessionClients.get(sessionId).forEach(c => {
    if (c.readyState === 1 && c._participantName === participantName) c.send(message);
  });
}

module.exports = { initWebSocket, broadcastToSession, broadcastToAdmins, sendToParticipant };
