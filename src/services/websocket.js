const { WebSocketServer } = require('ws');
let wss;
const sessionClients = new Map();

// Per session: participantName -> { rms, smoothedRMS, noiseFloor, snr, manualOverride, lastUpdate, lastSpeakingAt }
const sessionRMS = new Map();
const activeSpeakers = new Map();
const speakerLockUntil = new Map();

// Tuning constants
const SPEAKER_LOCK_MS = 800;            // hold active speaker for 800ms min
const NOISE_FLOOR_ALPHA = 0.05;         // faster noise floor adaptation — laptop floor rises when room gets loud
const NOISE_FLOOR_INIT = 0.008;         // starting assumption for noise floor
const SNR_SPEECH_THRESHOLD = 2.5;       // RMS must be 2.5x above own noise floor to count as speech
const SNR_DOMINANCE_RATIO = 2.2;        // winner needs 2.2x SNR advantage — much harder for far mic to steal
const SILENCE_RELEASE_MS = 800;         // release lock faster when current speaker goes quiet
const RMS_SMOOTHING_RISING = 0.6;       // faster attack — react to new speaker quickly
const RMS_SMOOTHING_FALLING = 0.10;     // slower decay — don't drop out mid-sentence

function getSessionRMS(sessionId) {
  if (!sessionRMS.has(sessionId)) sessionRMS.set(sessionId, new Map());
  return sessionRMS.get(sessionId);
}

function updateParticipantRMS(sessionId, participantName, rawRMS, manualOverride) {
  const rmsMap = getSessionRMS(sessionId);
  const existing = rmsMap.get(participantName) || {
    smoothedRMS: 0,
    noiseFloor: NOISE_FLOOR_INIT,
    manualOverride: false,
    lastUpdate: Date.now(),
    lastSpeakingAt: 0,
  };

  // Asymmetric smoothing
  const alpha = rawRMS > existing.smoothedRMS ? RMS_SMOOTHING_RISING : RMS_SMOOTHING_FALLING;
  const smoothed = existing.smoothedRMS * (1 - alpha) + rawRMS * alpha;

  // Noise floor: only adapt upward/downward when signal is near silence
  // This captures the ambient mic level for this specific device in this room
  let noiseFloor = existing.noiseFloor;
  const snrEstimate = smoothed / (noiseFloor + 1e-10);
  if (snrEstimate < 1.5) {
    // Signal is near noise floor — update noise floor estimate
    noiseFloor = noiseFloor * (1 - NOISE_FLOOR_ALPHA) + smoothed * NOISE_FLOOR_ALPHA;
    // Clamp noise floor so it doesn't drift too high or too low
    noiseFloor = Math.max(0.003, Math.min(0.025, noiseFloor));
  }

  // SNR for this participant: how much louder than their own noise floor
  const snr = smoothed / (noiseFloor + 1e-10);

  const now = Date.now();
  rmsMap.set(participantName, {
    rms: rawRMS,
    smoothedRMS: smoothed,
    noiseFloor,
    snr,
    manualOverride,
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

  // Manual override always wins immediately — no lock, no ratio check
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

  // Within lock window — check if current speaker has gone silent
  if (now < lockUntil && current) {
    const currentData = rmsMap.get(current);
    if (currentData) {
      const silentFor = now - currentData.lastSpeakingAt;
      // Release lock early only if current speaker has been below speech threshold for a while
      if (silentFor < SILENCE_RELEASE_MS) {
        return current; // Still speaking or recently spoke — hold lock
      }
      // Fall through — current speaker has gone silent, allow re-election
      console.log(`[RMS] Lock released — ${current} silent for ${silentFor}ms`);
    }
  }

  // Collect active participants with their SNR
  const candidates = [];
  for (const [name, data] of rmsMap.entries()) {
    if (now - data.lastUpdate < 1500) {
      candidates.push({ name, snr: data.snr, smoothedRMS: data.smoothedRMS, noiseFloor: data.noiseFloor });
    }
  }

  if (candidates.length === 0) return current;

  // Filter to only those actually speaking (SNR above threshold)
  const speaking = candidates.filter(c => c.snr >= SNR_SPEECH_THRESHOLD);

  if (speaking.length === 0) {
    // Nobody is speaking — keep current but don't lock
    return current;
  }

  if (speaking.length === 1) {
    const only = speaking[0];
    if (only.name !== current) {
      console.log(`[RMS] Speaker → ${only.name} (snr=${only.snr.toFixed(2)}, floor=${only.noiseFloor.toFixed(4)})`);
      activeSpeakers.set(sessionId, only.name);
      speakerLockUntil.set(sessionId, now + SPEAKER_LOCK_MS);
    }
    return only.name;
  }

  // Multiple people above speech threshold — pick by SNR dominance
  speaking.sort((a, b) => b.snr - a.snr);
  const top = speaking[0];
  const second = speaking[1];

  const ratio = top.snr / (second.snr + 1e-10);

  if (ratio < SNR_DOMINANCE_RATIO) {
    // Ambiguous — keep current speaker
    // But if current is not in the speaking list at all, switch to top
    const currentStillSpeaking = speaking.find(c => c.name === current);
    if (!currentStillSpeaking) {
      console.log(`[RMS] Speaker → ${top.name} (current gone silent, snr=${top.snr.toFixed(2)})`);
      activeSpeakers.set(sessionId, top.name);
      speakerLockUntil.set(sessionId, now + SPEAKER_LOCK_MS);
      return top.name;
    }
    return current;
  }

  if (top.name !== current) {
    console.log(`[RMS] Speaker → ${top.name} (snr=${top.snr.toFixed(2)}, ratio=${ratio.toFixed(2)}, floor=${top.noiseFloor.toFixed(4)})`);
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
          const activeSpeaker = activeSpeakers.get(sessionId);
          if (!activeSpeaker || activeSpeaker === participantName) {
            sendAudioChunk(sessionId, data, participantName);
          }
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
