const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const supabase = require('./supabase');

const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);

const activeConnections = new Map();
const sessionState = new Map();
const recentUtterances = new Map();

// Session-scoped analysis intervals — NOT connection-scoped
// This survives participant reconnects
const analysisIntervals = new Map();

const DEDUP_WINDOW_MS = 3000;
const DEDUP_SIMILARITY = 0.85;

function getSessionState(sessionId) {
  if (!sessionState.has(sessionId)) {
    sessionState.set(sessionId, {
      topic: null,
      sessionConfig: {},
      participantStats: {},
      recentTranscript: [],   // string array: "[name]: utterance"
      utteranceBuffer: {},
    });
  }
  return sessionState.get(sessionId);
}

function getConnectionKey(sessionId, participantName) {
  return `${sessionId}::${participantName}`;
}

function stringSimilarity(a, b) {
  const wordsA = a.toLowerCase().split(/\s+/);
  const wordsB = b.toLowerCase().split(/\s+/);
  const setB = new Set(wordsB);
  const intersection = wordsA.filter(w => setB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / (union + 1e-10);
}

function isDuplicate(sessionId, participantName, utterance, currentSNR) {
  if (!recentUtterances.has(sessionId)) recentUtterances.set(sessionId, []);
  const recent = recentUtterances.get(sessionId);
  const now = Date.now();
  const fresh = recent.filter(u => now - u.timestamp < DEDUP_WINDOW_MS);
  recentUtterances.set(sessionId, fresh);
  for (const prev of fresh) {
    if (prev.participantName === participantName) continue;
    const similarity = stringSimilarity(utterance, prev.text);
    if (similarity >= DEDUP_SIMILARITY) {
      if (currentSNR >= prev.snr) { prev.superseded = true; return false; }
      return true;
    }
  }
  fresh.push({ text: utterance, participantName, timestamp: now, snr: currentSNR });
  return false;
}

// ─── Session-scoped analysis interval ────────────────────────────────────────
// Starts when first participant connects, stays alive even if they disconnect.
// Cleared only when session ends (stopTranscription).
function startAnalysisInterval(sessionId) {
  if (analysisIntervals.has(sessionId)) return; // already running

  console.log(`[Analysis] Starting interval for session ${sessionId}`);
  const interval = setInterval(async () => {
    const state = sessionState.get(sessionId);
    if (!state || Object.keys(state.participantStats).length === 0) return;

    try {
      const { analyseGroupState } = require('./scoring');
      const result = await analyseGroupState({
        sessionId,
        topic: state.topic,
        participantStats: state.participantStats,
        recentTranscript: state.recentTranscript.join('\n'),
        sessionConfig: state.sessionConfig,
      });

      if (result.intervention_needed && result.prompt) {
        console.log(`[Analysis] Intervention: ${result.type} → ${result.target}: "${result.prompt.slice(0, 60)}..."`);
        const { broadcastToSession, sendToParticipant, broadcastToAdmins } = require('./websocket');

        broadcastToAdmins(sessionId, 'PROMPT_SUGGESTION', {
          target: result.target, flag: result.type,
          prompt: result.prompt, reasoning: result.reasoning,
        });

        if (result.target === 'group') {
          broadcastToSession(sessionId, 'AI_PROMPT', {
            target: 'group', prompt: result.prompt, type: result.type,
          });
        } else {
          sendToParticipant(sessionId, result.target, 'AI_PROMPT', {
            target: result.target, prompt: result.prompt, type: result.type,
          });
        }

        // Log to DB
        supabase.from('prompts_log').insert({
          session_id: sessionId,
          target: result.target,
          prompt_text: result.prompt,
          prompt_type: result.type,
          issued_by: 'ai_engine',
        }).then().catch(() => {});
      } else {
        console.log(`[Analysis] No intervention needed for session ${sessionId}`);
      }
    } catch (err) {
      console.error('[Analysis] Error:', err.message);
    }
  }, 30000); // 30s — fast enough for testing, change to 60000 for production

  analysisIntervals.set(sessionId, interval);
}

async function ensureConnection(sessionId, participantName) {
  const key = getConnectionKey(sessionId, participantName);
  if (activeConnections.has(key)) return activeConnections.get(key);

  console.log(`[Deepgram] Opening connection for ${participantName} in session ${sessionId}`);

  // Placeholder set BEFORE await — prevents race condition
  const connData = { connection: null, buffer: [], isOpen: false, keepAliveInterval: null };
  activeConnections.set(key, connData);

  const state = getSessionState(sessionId);
  if (!state.topic) {
    try {
      const { data } = await supabase.from('sessions').select('topic, session_config').eq('id', sessionId).single();
      state.topic = data?.topic || '';
      state.sessionConfig = data?.session_config || {};
    } catch (e) {}
  }

  const connection = deepgramClient.listen.live({
    model: 'nova-2', language: 'en', smart_format: true,
    interim_results: true, punctuate: true, encoding: 'linear16',
    sample_rate: 16000, channels: 1, endpointing: 500,
  });
  connData.connection = connection;

  connection.on(LiveTranscriptionEvents.Open, () => {
    console.log(`[Deepgram] Connection OPEN for ${participantName}`);
    connData.isOpen = true;

    if (connData.buffer.length > 0) {
      connData.buffer.forEach(chunk => connection.send(chunk));
      connData.buffer = [];
    }

    connData.keepAliveInterval = setInterval(() => {
      try { connection.keepAlive(); } catch (e) {}
    }, 8000);

    // Start session-scoped analysis interval (idempotent)
    startAnalysisInterval(sessionId);
  });

  connection.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const alt = data?.channel?.alternatives?.[0];
    if (!alt || !alt.transcript || alt.transcript.trim() === '') return;
    if (data.is_final === false) return;

    const utterance = alt.transcript.trim();
    if (utterance.split(' ').length < 3) return;

    const { getParticipantSNR } = require('./websocket');
    const currentSNR = getParticipantSNR ? getParticipantSNR(sessionId, participantName) : 1.0;

    if (isDuplicate(sessionId, participantName, utterance, currentSNR)) return;

    console.log(`[Deepgram] Transcript: ${participantName} - ${utterance}`);

    await supabase.from('transcripts').insert({
      session_id: sessionId,
      speaker_name: participantName,
      utterance,
      timestamp_seconds: 0,
    });

    const state = getSessionState(sessionId);
    if (!state.participantStats[participantName]) {
      state.participantStats[participantName] = { talkTimeSeconds: 0, utteranceCount: 0 };
    }
    state.participantStats[participantName].utteranceCount += 1;
    state.participantStats[participantName].talkTimeSeconds += utterance.split(' ').length * 0.4;
    state.recentTranscript.push(`[${participantName}]: ${utterance}`);
    if (state.recentTranscript.length > 20) state.recentTranscript.shift();

    const { broadcastToAdmins } = require('./websocket');
    broadcastToAdmins(sessionId, 'NEW_UTTERANCE', {
      speakerTag: participantName, utterance, timestamp: new Date().toISOString(),
    });

    if (!state.utteranceBuffer[participantName]) state.utteranceBuffer[participantName] = [];
    state.utteranceBuffer[participantName].push(utterance);
    if (state.utteranceBuffer[participantName].length >= 3) {
      const batch = state.utteranceBuffer[participantName].join(' ');
      state.utteranceBuffer[participantName] = [];
      scoreAndBroadcast(sessionId, state, participantName, batch);
    }
  });

  connection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error(`[Deepgram] Error for ${participantName}:`, err.message);
  });

  connection.on(LiveTranscriptionEvents.Close, () => {
    console.log(`[Deepgram] Connection CLOSED for ${participantName}`);
    connData.isOpen = false;
    if (connData.keepAliveInterval) clearInterval(connData.keepAliveInterval);
    activeConnections.delete(key);
    // NOTE: analysis interval NOT cleared here — it's session-scoped
  });

  return connData;
}

async function scoreAndBroadcast(sessionId, state, speakerTag, batch) {
  try {
    const { scoreUtterance } = require('./scoring');
    const { broadcastToAdmins } = require('./websocket');
    const scoreResult = await scoreUtterance(sessionId, speakerTag, batch, state.topic, state.sessionConfig);
    if (!scoreResult) { console.warn(`[Scoring] No result for ${speakerTag}`); return; }
    await updateParticipantScore(sessionId, speakerTag, scoreResult);
    broadcastToAdmins(sessionId, 'SCORE_UPDATE', {
      speakerTag, scores: scoreResult.scores,
      bloom_level: scoreResult.bloom_level,
      objective_scores: scoreResult.objective_scores || null,
      participationStats: state.participantStats[speakerTag],
    });
  } catch (err) {
    console.error('[Scoring] Error:', err.message);
  }
}

async function updateParticipantScore(sessionId, speakerTag, scoreResult) {
  try {
    const { data: existing } = await supabase.from('scores').select('*')
      .eq('session_id', sessionId).eq('speaker_tag', speakerTag).single();
    const scores = scoreResult.scores;
    const bloomLevel = scoreResult.bloom_level;
    if (existing) {
      const n = existing.utterance_count || 1;
      const avg = (old, next) => ((old * n) + next) / (n + 1);
      await supabase.from('scores').update({
        topic_adherence: avg(existing.topic_adherence, scores.topic_adherence),
        depth: avg(existing.depth, scores.depth),
        material_application: avg(existing.material_application, scores.material_application),
        overall_score: avg(existing.overall_score, scores.overall_score),
        bloom_level: bloomLevel, utterance_count: n + 1,
      }).eq('id', existing.id);
    } else {
      await supabase.from('scores').insert({
        session_id: sessionId, speaker_tag: speakerTag,
        topic_adherence: scores.topic_adherence, depth: scores.depth,
        material_application: scores.material_application,
        overall_score: scores.overall_score,
        bloom_level: bloomLevel, utterance_count: 1,
      });
    }
  } catch (err) {
    console.error('[Score Update] Error:', err.message);
  }
}

async function sendAudioChunk(sessionId, chunk, participantName) {
  if (!participantName || participantName === 'unknown') return;
  try {
    const connData = await ensureConnection(sessionId, participantName);
    if (connData.isOpen) connData.connection.send(chunk);
    else connData.buffer.push(chunk);
  } catch (err) {
    console.error(`[Audio] Chunk error for ${participantName}:`, err.message);
  }
}

async function stopTranscription(sessionId) {
  console.log(`[Transcription] Stopping all connections for session ${sessionId}`);

  // Clear session-scoped analysis interval
  if (analysisIntervals.has(sessionId)) {
    clearInterval(analysisIntervals.get(sessionId));
    analysisIntervals.delete(sessionId);
  }

  const keysToClose = [...activeConnections.keys()].filter(k => k.startsWith(sessionId + '::'));
  for (const key of keysToClose) {
    const connData = activeConnections.get(key);
    if (!connData) continue;
    const participantName = key.split('::')[1];
    const state = getSessionState(sessionId);
    if (state.utteranceBuffer[participantName]?.length > 0) {
      const batch = state.utteranceBuffer[participantName].join(' ');
      state.utteranceBuffer[participantName] = [];
      await scoreAndBroadcast(sessionId, state, participantName, batch);
    }
    if (connData.keepAliveInterval) clearInterval(connData.keepAliveInterval);
    try { connData.connection.finish(); } catch (e) {}
    activeConnections.delete(key);
  }

  recentUtterances.delete(sessionId);
  sessionState.delete(sessionId);
  console.log(`[Transcription] All connections closed for session ${sessionId}`);
}

function startTranscription(sessionId, topic, sessionConfig) {
  console.log(`[Transcription] Session ${sessionId} ready`);
  const state = getSessionState(sessionId);
  if (topic) state.topic = topic;
  if (sessionConfig) state.sessionConfig = sessionConfig;
}

function getSessionStats(sessionId) {
  return sessionState.get(sessionId)?.participantStats || {};
}

// For websocket.js to send opening question to late joiners
function getSessionInfo(sessionId) {
  const state = sessionState.get(sessionId);
  if (!state) return null;
  return {
    openingQuestion: state.sessionConfig?.opening_question || null,
    topic: state.topic,
  };
}

module.exports = { sendAudioChunk, startTranscription, stopTranscription, getSessionStats, getSessionInfo };
