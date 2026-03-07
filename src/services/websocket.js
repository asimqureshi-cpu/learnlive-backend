const { WebSocketServer } = require('ws');
let wss;
const sessionClients = new Map();

// RMS tracking per session: sessionId -> { participantName -> { rms, manualOverride, lastUpdate } }
const sessionRMS = new Map();

// Active speaker per session — recalculated every 250ms
const activeSpeakers = new Map();

function getSessionRMS(sessionId) {
  if (!sessionRMS.has(sessionId)) sessionRMS.set(sessionId, new Map());
  return sessionRMS.get(sessionId);
}

function electActiveSpeaker(sessionId) {
  const rmsMap = sessionRMS.get(sessionId);
  if (!rmsMap || rmsMap.size === 0) return null;

  const now = Date.now();
  let winner = null;
  let highestRMS = 0;

  for (const [name, data] of rmsMap.entries()) {
    // Ignore stale readings older than 1 second
    if (now - data.lastUpdate > 1000) continue;

    // Manual override always wins
    if (data.manualOverride) {
      winner = name;
      break;
    }

    if (data.rms > highestRMS) {
      highestRMS = data.rms;
      winner = name;
    }
  }

  // Only switch if RMS is above silence threshold (0.01) or manual override
  const prev = activeSpeakers.get(sessionId);
  const rmsData = winner ? rmsMap.get(winner) : null;
  if (!rmsData?.manualOverride && highestRMS < 0.01) return prev; // keep previous speaker during brief silences

  if (winner !== prev) {
    activeSpeakers.set(sessionId, winner);
    if (winner) console.log(`[RMS] Active speaker for session ${sessionId}: ${winner} (rms=${highestRMS.toFixed(3)}, override=${rmsData?.manualOverride})`);
  }

  return winner;
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
      // Initialise RMS entry for this participant
      const rmsMap = getSessionRMS(sessionId);
      rmsMap.set(participantName, { rms: 0, manualOverride: false, lastUpdate: Date.now() });

      ws.on('message', (data, isBinary) => {
        if (!sessionId) return;

        const { sendAudioChunk } = require('./transcription');

        if (!isBinary) {
          // JSON control message — RMS report
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'rms') {
              const rmsMap = getSessionRMS(sessionId);
              rmsMap.set(participantName, {
                rms: msg.rms || 0,
                manualOverride: msg.manualOverride || false,
                lastUpdate: Date.now(),
              });

              // Elect active speaker
              const activeSpeaker = electActiveSpeaker(sessionId);

              // Only send audio to transcription if this participant is the active speaker
              // We don't send audio here — audio chunks come as binary messages
              // Just update the active speaker map
            }
          } catch (e) {
            console.error('[WS] JSON parse error:', e.message);
          }
        } else {
          // Binary message — PCM audio chunk
          // Only forward to transcription if this participant is the current active speaker
          const activeSpeaker = activeSpeakers.get(sessionId) || participantName;

          if (activeSpeaker === participantName) {
            sendAudioChunk(sessionId, data, participantName);
          }
          // else: suppress — another participant has higher RMS or manual override
        }
      });

      ws.on('close', () => {
        console.log(`[Audio] Stream closed for ${participantName}`);
        const rmsMap = sessionRMS.get(sessionId);
        if (rmsMap) rmsMap.delete(participantName);
      });

      ws.on('error', (e) => console.error('[Audio] Error:', e.message));
      ws.send(JSON.stringify({ event: 'AUDIO_CONNECTED' }));
      return;
    }

    // Non-audio client (admin, participant control channel)
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
