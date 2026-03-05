const { WebSocketServer } = require('ws');

let wss;
const sessionClients = new Map(); // sessionId -> Set of ws clients

function initWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const sessionId = url.searchParams.get('sessionId');
    const role = url.searchParams.get('role'); // 'admin' or 'participant'

    if (sessionId) {
      if (!sessionClients.has(sessionId)) {
        sessionClients.set(sessionId, new Set());
      }
      sessionClients.get(sessionId).add(ws);
      ws._sessionId = sessionId;
      ws._role = role;
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

// Broadcast to all clients watching a session (admins + participants)
function broadcastToSession(sessionId, event, data) {
  if (!sessionClients.has(sessionId)) return;
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  sessionClients.get(sessionId).forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// Broadcast only to admin clients of a session
function broadcastToAdmins(sessionId, event, data) {
  if (!sessionClients.has(sessionId)) return;
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  sessionClients.get(sessionId).forEach(client => {
    if (client.readyState === 1 && client._role === 'admin') {
      client.send(message);
    }
  });
}

// Send to a specific participant
function sendToParticipant(sessionId, participantName, event, data) {
  if (!sessionClients.has(sessionId)) return;
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  sessionClients.get(sessionId).forEach(client => {
    if (client.readyState === 1 && client._participantName === participantName) {
      client.send(message);
    }
  });
}

module.exports = { initWebSocket, broadcastToSession, broadcastToAdmins, sendToParticipant };
