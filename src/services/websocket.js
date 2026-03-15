const { WebSocketServer } = require('ws');
let wss;
const sessionClients = new Map();

const sessionRMS = new Map();
const activeSpeakers = new Map();
const speakerLockUntil = new Map();

const SPEAKER_LOCK_MS = 800;
const NOISE_FLOOR_ALPHA = 0.05;
const NOISE_FLOOR_INIT = 0.008;
const SNR_SPEECH_THRESHOLD = 2.5;
const SNR_DOMINANCE_RATIO = 2.2;
const SILENCE_RELEASE_MS = 800;
const RMS_SMOOTHING_RISING = 0.6;
const RMS_SMOOTHING_FALLING = 0.10;

function getSessionRMS(sessionId) {
  if (!sessionRMS.has(sessionId)) sessionRMS.set(sessionId, new Map());
  return sessionRMS.get(sessionId);
}

function updateParticipantRMS(sessionId, participantName, rawRMS, manualOverride) {
  const rmsMap = getSessionRMS(sessionId);
  const existing = rmsMap.get(participantName) || {
    smoothedRMS: 0, noiseFloor: NOISE_FLOOR_INIT,
    manualOverride: false, lastUpdate: Date.now(), lastSpeakingAt: 0,
  };

  const alpha = rawRMS > existing.smoothedRMS ? RMS_SMOOTHING_RISING : RMS_SMOOTHING_FALLING;
  const smoothed = existing.smoothedRMS * (1 - alpha) + rawRMS * alpha;

  let noiseFloor = existing.noiseFloor;
  const snrEstimate = smoothed / (noiseFloor + 1e-10);
  if (snrEstimate < 1.5) {
    noiseFloor = noiseFloor * (1 - NOISE_FLOOR_ALPHA) + smoothed * NOISE_FLOOR_ALPHA;
    noiseFloor = Math.max(0.003, Math.min(0.025, noiseFloor));
  }

  const snr = smoothed / (noiseFloor + 1e-10);
  const now = Date.now();
  rmsMap.set(participantName, {
    rms: rawRMS, smoothedRMS: smoothed, noiseFloor, snr, manualOverride,
    lastUpdate: now,
    lastSpeakingAt: snr > SNR_SPEECH_THRESHOLD ? now : existing.lastSpeakingAt,
  });
  return rmsMap.get(participantName);
}

function electActiveSpeaker(sessionId) {
  const rmsMap = sessionRMS.get(sessionId);
  if (!rmsMap || rmsMap.size === 0) return null;

  const now = Date.now();
  const current = activeSpeakers.get(sessionId);
  const lockUntil = speakerLockUntil.get(sessionId) || 0;

  for (const [name, data] of rmsMap.entries()) {
    if (data.manualOverride && now - data.lastUpdate < 1500) {
      if (name !== current) {
        console.log(`[RMS] Override → ${name}`);
        activeSpeakers.set(sessionId, name);
        speakerLockUntil.set(sessionId, now + SPEAKER_LOCK_MS);
      }
      return name;
    }
  }

  if (now < lockUntil && current) {
    const currentData = rmsMap.get(current);
    if (currentData) {
      const silentFor = now - currentData.lastSpeakingAt;
      if (silentFor < SILENCE_RELEASE_MS) return current;
      console.log(`[RMS] Lock released — ${current} silent for ${silentFor}ms`);
    }
  }

  const candidates = [];
  for (const [name, data] of rmsMap.entries()) {
    if (now - data.lastUpdate < 1500) {
      candidates.push({ name, snr: data.snr, smoothedRMS: data.smoothedRMS, noiseFloor: data.noiseFloor });
    }
  }

  if (candidates.length === 0) return current;
  const speaking = candidates.filter(c => c.snr >= SNR_SPEECH_THRESHOLD);
  if (speaking.length === 0) return current;

  if (speaking.length === 1) {
    const only = speaking[0];
    if (only.name !== current) {
      console.log(`[RMS] Speaker → ${only.name} (snr=${only.snr.toFixed(2)}, floor=${only.noiseFloor.toFixed(4)})`);
      activeSpeakers.set(sessionId, only.name);
      speakerLockUntil.set(sessionId, now + SPEAKER_LOCK_MS);
    }
    return only.name;
  }

  speaking.sort((a, b) => b.snr - a.snr);
  const top = speaking[0];
  const second = speaking[1];
  const ratio = top.snr / (second.snr + 1e-10);

  if (ratio < SNR_DOMINANCE_RATIO) {
    const currentStillSpeaking = speaking.find(c => c.name === current);
    if (!currentStillSpeaking) {
      console.log(`[RMS] Speaker → ${top.name} (current gone silent)`);
      activeSpeakers.set(sessionId, top.name);
      speakerLockUntil.set(sessionId, now + SPEAKER_LOCK_MS);
      return top.name;
    }
    return current;
  }

  if (top.name !== current) {
    console.log(`[RMS] Speaker → ${top.name} (snr=${top.snr.toFixed(2)}, ratio=${ratio.toFixed(2)})`);
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

    // ── Audio stream connection ──────────────────────────────────────────────
    if (type === 'audio') {
      const rmsMap = getSessionRMS(sessionId);
      rmsMap.set(participantName, {
        rms: 0, smoothedRMS: 0, noiseFloor: NOISE_FLOOR_INIT,
        snr: 0, manualOverride: false, lastUpdate: Date.now(), lastSpeakingAt: 0,
      });

      ws.on('message', (data, isBinary) => {
        if (!sessionId) return;
        const { sendAudioChunk } = require('./transcription');
        if (!isBinary) {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'rms') {
              updateParticipantRMS(sessionId, participantName, msg.rms || 0, msg.manualOverride || false);
              electActiveSpeaker(sessionId);
            }
          } catch (e) {}
        } else {
          sendAudioChunk(sessionId, data, participantName);
        }
      });

      ws.on('close', () => {
        console.log(`[Audio] Stream closed for ${participantName}`);
        const rmsMap = sessionRMS.get(sessionId);
        if (rmsMap) rmsMap.delete(participantName);
        if (activeSpeakers.get(sessionId) === participantName) {
          activeSpeakers.delete(sessionId);
          speakerLockUntil.delete(sessionId);
        }
      });

      ws.on('error', (e) => console.error('[Audio] Error:', e.message));
      ws.send(JSON.stringify({ event: 'AUDIO_CONNECTED' }));
      return;
    }

    // ── Control/prompt WebSocket ─────────────────────────────────────────────
    if (sessionId) {
      if (!sessionClients.has(sessionId)) sessionClients.set(sessionId, new Set());
      sessionClients.get(sessionId).add(ws);

      // Send opening question immediately to this participant on connect.
      // Handles BOTH on-time joiners (session just started) and late joiners.
      if (role === 'participant' && participantName && participantName !== 'unknown') {
        try {
          const { getSessionInfo } = require('./transcription');
          const info = getSessionInfo(sessionId);
          if (info && info.openingQuestion) {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({
                event: 'SESSION_STARTED',
                data: { opening_question: info.openingQuestion, topic: info.topic },
                timestamp: new Date().toISOString(),
              }));
              console.log(`[WS] Opening question sent to: ${participantName}`);
            }
          }
        } catch (e) {
          // Session not started yet — normal, skip silently
        }
      }
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

function getParticipantSNR(sessionId, participantName) {
  const rmsMap = sessionRMS.get(sessionId);
  if (!rmsMap) return 1.0;
  const data = rmsMap.get(participantName);
  return data ? (data.snr || 1.0) : 1.0;
}

module.exports = { initWebSocket, broadcastToSession, broadcastToAdmins, sendToParticipant, getParticipantSNR };
