const { WebSocketServer } = require('ws');

let wss;
const sessionClients = new Map();

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
      ws.on('message', (audioChunk) => {
  if (sessionId) {
    const { sendAudioChunk } = require('./transcription');
    sendAudioChunk(sessionId, audioChunk, participantName);
  }
});
      ws.on('close', () => console.log(`[Audio] Stream closed for ${participantName}`));
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
