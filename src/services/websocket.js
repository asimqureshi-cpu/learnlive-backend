const { WebSocketServer } = require('ws');
const { sendAudioChunk, startTranscription } = require('./transcription');

let wss;
const sessionClients = new Map();

function initWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const sessionId = url.searchParams.get('sessionId');
    const role = url.searchParams.get('role');
    const participantName = url.searchParams.get('participantName');

    // Audio streaming endpoint from participants
    if (pathname === '/ws/audio') {
      ws._type = 'audio';
      ws._sessionId = sessionId;
      ws._participantName = participantName;

      ws.on('message', (audioChunk) => {
        if (sessionId) {
          sendAudioChunk(sessionId, audioChunk);
        }
      });

      ws.on('close', () => console.log(`[Audio] Stream closed for ${participantName}`));
      ws.on('error', console.error);
      return;
    }

    // Dashboard/participant control WebSocket
    if (sessionId) {
      if (!sessionClients.has(sessionId)) {
        sessionClients.set(sessionId, new Set());
      }
      sessionClients.get(sessionId).add(ws);
      ws._sessionId = sessionId;
      ws._role = role;
      ws._participantName = participantName;
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
  sessionClients.get(sessionId).forEach(client => {
    if (client.readyState === 1) client.send(message);
  });
}

function broadcastToAdmins(sessionId, event, data) {
  if (!sessionClients.has(sessionId)) return;
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  sessionClients.get(sessionId).forEach(client => {
    if (client.readyState === 1 && client._role === 'admin') client.send(message);
  });
}

function sendToParticipant(sessionId, participantName, event, data) {
  if (!sessionClients.has(sessionId)) return;
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  sessionClients.get(sessionId).forEach(client => {
    if (client.readyState === 1 && client._participantName === participantName) client.send(message);
  });
}

module.exports = { initWebSocket, broadcastToSession, broadcastToAdmins, sendToParticipant };
