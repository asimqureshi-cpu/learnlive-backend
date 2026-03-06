const { WebSocketServer } = require('ws');

let wss;
const sessionClients = new Map();

function initWebSocket(server) {
  wss = new WebSocketServer({ server, noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    
    wss.handleUpgrade(request, socket, head, (ws) => {
      const sessionId = url.searchParams.get('sessionId');
      const role = url.searchParams.get('role');
      const participantName = url.searchParams.get('participantName');
      const isAudio = url.pathname === '/ws/audio';

      ws._sessionId = sessionId;
      ws._role = role;
      ws._participantName = participantName;
      ws._isAudio = isAudio;

      if (isAudio) {
        // Audio streaming from participant browser to Deepgram
        ws.on('message', async (audioChunk) => {
          if (sessionId) {
            const { sendAudioChunk } = require('./transcription');
            sendAudioChunk(sessionId, audioChunk);
          }
        });

        ws.on('close', () => {
          console.log(`[Audio] Stream closed for ${participantName}`);
        });

        ws.on('error', (err) => {
          console.error('[Audio] WebSocket error:', err.message);
        });

        ws.send(JSON.stringify({ event: 'AUDIO_CONNECTED', data: { sessionId } }));

      } else {
        // Dashboard control WebSocket
        if (sessionId) {
          if (!sessionClients.has(sessionId)) {
            sessionClients.set(sessionId, new Set());
          }
          sessionClients.get(sessionId).add(ws);
        }

        ws.on('close', () => {
          if (ws._sessionId && sessionClients.has(ws._sessionId)) {
            sessionClients.get(ws._sessionId).delete(ws);
          }
        });

        ws.on('error', console.error);
      }
    });
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
```

Commit → wait for Railway green → then:

1. Create a fresh session
2. Upload a PDF
3. Start the session
4. Join in incognito → allow microphone → speak for 60 seconds
5. Check Railway Deploy Logs — you should now see:
```
[Audio] Stream closed for [name]
[Deepgram] Transcript received: ...
