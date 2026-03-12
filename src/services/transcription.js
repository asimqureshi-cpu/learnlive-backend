const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const supabase = require('./supabase');

const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);

// Map key: `${sessionId}::${participantName}` → per-participant connection data
const activeConnections = new Map();

// Session-level shared state
const sessionState = new Map();

// Deduplication: track recent utterances per session to catch bleed
// key: sessionId → array of { text, participantName, timestamp, snr }
const recentUtterances = new Map();
const DEDUP_WINDOW_MS = 3000;     // utterances within 3s are candidates for dedup
const DEDUP_SIMILARITY = 0.85;    // 85% word overlap = same utterance

function getSessionState(sessionId) {
  if (!sessionState.has(sessionId)) {
    sessionState.set(sessionId, {
      topic: null,
      participantStats: {},
      recentTranscript: [],
      utteranceBuffer: {},
    });
  }
  return sessionState.get(sessionId);
}

function getConnectionKey(sessionId, participantName) {
  return `${sessionId}::${participantName}`;
}

// Calculate word overlap similarity between two strings
function stringSimilarity(a, b) {
  const wordsA = a.toLowerCase().split(/\s+/);
  const wordsB = b.toLowerCase().split(/\s+/);
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  const intersection = wordsA.filter(w => setB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / (union + 1e-10);
}

// Returns true if this utterance is a bleed duplicate of a recently seen one
// Keeps the version from the device with higher SNR
function isDuplicate(sessionId, participantName, utterance, currentSNR) {
  if (!recentUtterances.has(sessionId)) recentUtterances.set(sessionId, []);
  const recent = recentUtterances.get(sessionId);
  const now = Date.now();

  // Clean up old entries
  const fresh = recent.filter(u => now - u.timestamp < DEDUP_WINDOW_MS);
  recentUtterances.set(sessionId, fresh);

  // Check for similar utterances from other participants
  for (const prev of fresh) {
    if (prev.participantName === participantName) continue; // same person, not a dupe
    const similarity = stringSimilarity(utterance, prev.text);
    if (similarity >= DEDUP_SIMILARITY) {
      // Duplicate detected — keep whichever has higher SNR
      if (currentSNR >= prev.snr) {
        // Current is better — remove the old one from recent so it doesn't block future
        prev.superseded = true;
        console.log(`[Dedup] ${participantName} supersedes ${prev.participantName} (sim=${similarity.toFixed(2)}, snr=${currentSNR.toFixed(2)} vs ${prev.snr.toFixed(2)})`);
        return false; // Allow this one through
      } else {
        // Previous was better — discard current
        console.log(`[Dedup] Dropping bleed from ${participantName} (sim=${similarity.toFixed(2)}, snr=${currentSNR.toFixed(2)} vs ${prev.snr.toFixed(2)})`);
        return true;
      }
    }
  }

  // Not a duplicate — register it
  fresh.push({ text: utterance, participantName, timestamp: now, snr: currentSNR, superseded: false });
  return false;
}

function getCurrentSNR(sessionId, participantName) {
  try {
    const { sessionRMS } = require('./websocket').__testExports || {};
    // Fallback: get SNR from websocket module if exported, otherwise use 1.0
    return 1.0;
  } catch {
    return 1.0;
  }
}

async function ensureConnection(sessionId, participantName) {
  const key = getConnectionKey(sessionId, participantName);
  if (activeConnections.has(key)) return activeConnections.get(key);

  console.log(`[Deepgram] Opening connection for ${participantName} in session ${sessionId}`);

  const state = getSessionState(sessionId);
  if (!state.topic) {
    try {
      const { data } = await supabase.from('sessions').select('topic').eq('id', sessionId).single();
      state.topic = data?.topic || '';
    } catch (e) {}
  }

  const connData = {
    connection: null,
    buffer: [],
    isOpen: false,
    keepAliveInterval: null,
    groupAnalysisInterval: null,
  };
  activeConnections.set(key, connData);

  const connection = deepgramClient.listen.live({
    model: 'nova-2',
    language: 'en',
    smart_format: true,
    interim_results: true,
    punctuate: true,
    encoding: 'linear16',
    sample_rate: 16000,
    channels: 1,
    endpointing: 500,
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

    const allKeys = [...activeConnections.keys()].filter(k => k.startsWith(sessionId + '::'));
    if (allKeys.length === 1) {
      connData.groupAnalysisInterval = setInterval(async () => {
        const state = getSessionState(sessionId);
        if (Object.keys(state.participantStats).length === 0) return;
        try {
          const { analyseGroupState } = require('./scoring');
          const result = await analyseGroupState({
            sessionId,
            topic: state.topic,
            participantStats: state.participantStats,
            recentTranscript: state.recentTranscript.join('\n'),
          });
          if (result.intervention_needed && result.prompt) {
            console.log(`[Group] Auto-nudge: ${result.type} -> ${result.target}`);
            const { broadcastToSession, sendToParticipant, broadcastToAdmins } = require('./websocket');
            broadcastToAdmins(sessionId, 'PROMPT_SUGGESTION', {
              target: result.target, flag: result.type,
              prompt: result.prompt, reasoning: result.reasoning,
            });
            if (result.target === 'group') {
              broadcastToSession(sessionId, 'AI_PROMPT', { target: 'group', prompt: result.prompt, type: result.type });
            } else {
              sendToParticipant(sessionId, result.target, 'AI_PROMPT', { target: result.target, prompt: result.prompt, type: result.type });
            }
          }
        } catch (err) {
          console.error('[Group Analysis] Error:', err.message);
        }
      }, 60000);
    }
  });

  connection.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const alt = data?.channel?.alternatives?.[0];
    if (!alt || !alt.transcript || alt.transcript.trim() === '') return;
    if (data.is_final === false) return;

    const utterance = alt.transcript.trim();
    if (utterance.split(' ').length < 3) return; // skip very short fragments

    const speakerTag = participantName;

    // Deduplication check — get current SNR for this participant from websocket state
    const { getParticipantSNR } = require('./websocket');
    const currentSNR = getParticipantSNR ? getParticipantSNR(sessionId, participantName) : 1.0;

    if (isDuplicate(sessionId, participantName, utterance, currentSNR)) return;

    console.log(`[Deepgram] Transcript: ${speakerTag} - ${utterance}`);

    await supabase.from('transcripts').insert({
      session_id: sessionId,
      speaker_name: speakerTag,
      utterance,
      timestamp_seconds: 0,
    });

    const state = getSessionState(sessionId);
    if (!state.participantStats[speakerTag]) {
      state.participantStats[speakerTag] = { talkTimeSeconds: 0, utteranceCount: 0 };
    }
    state.participantStats[speakerTag].utteranceCount += 1;
    state.participantStats[speakerTag].talkTimeSeconds += utterance.split(' ').length * 0.4;
    state.recentTranscript.push(`[${speakerTag}]: ${utterance}`);
    if (state.recentTranscript.length > 20) state.recentTranscript.shift();

    const { broadcastToAdmins } = require('./websocket');
    broadcastToAdmins(sessionId, 'NEW_UTTERANCE', {
      speakerTag,
      utterance,
      timestamp: new Date().toISOString(),
    });

    if (!state.utteranceBuffer[speakerTag]) state.utteranceBuffer[speakerTag] = [];
    state.utteranceBuffer[speakerTag].push(utterance);
    if (state.utteranceBuffer[speakerTag].length >= 3) {
      const batch = state.utteranceBuffer[speakerTag].join(' ');
      state.utteranceBuffer[speakerTag] = [];
      scoreAndBroadcast(sessionId, state, speakerTag, batch);
    }
  });

  connection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error(`[Deepgram] Error for ${participantName}:`, err.message);
  });

  connection.on(LiveTranscriptionEvents.Close, () => {
    console.log(`[Deepgram] Connection CLOSED for ${participantName}`);
    connData.isOpen = false;
    if (connData.keepAliveInterval) clearInterval(connData.keepAliveInterval);
    if (connData.groupAnalysisInterval) clearInterval(connData.groupAnalysisInterval);
    activeConnections.delete(key);
  });

  return connData;
}

async function scoreAndBroadcast(sessionId, state, speakerTag, batch) {
  try {
    const { scoreUtterance } = require('./scoring');
    const { broadcastToAdmins } = require('./websocket');
    const scoreResult = await scoreUtterance(sessionId, speakerTag, batch, state.topic);
    if (!scoreResult) return;

    await updateParticipantScore(sessionId, speakerTag, scoreResult, state);

    broadcastToAdmins(sessionId, 'SCORE_UPDATE', {
      speakerTag,
      scores: scoreResult.scores,
      bloom_level: scoreResult.bloom_level,
      participationStats: state.participantStats[speakerTag],
    });
  } catch (err) {
    console.error('[Scoring] Error:', err.message);
  }
}

async function updateParticipantScore(sessionId, speakerTag, scoreResult, state) {
  try {
    const { data: existing } = await supabase
      .from('scores')
      .select('*')
      .eq('session_id', sessionId)
      .eq('speaker_tag', speakerTag)
      .single();

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
        bloom_level: bloomLevel,
        utterance_count: n + 1,
      }).eq('id', existing.id);
    } else {
      await supabase.from('scores').insert({
        session_id: sessionId,
        speaker_tag: speakerTag,
        topic_adherence: scores.topic_adherence,
        depth: scores.depth,
        material_application: scores.material_application,
        overall_score: scores.overall_score,
        bloom_level: bloomLevel,
        utterance_count: 1,
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
    if (connData.isOpen) {
      connData.connection.send(chunk);
    } else {
      connData.buffer.push(chunk);
    }
  } catch (err) {
    console.error(`[Audio] Chunk error for ${participantName}:`, err.message);
  }
}

async function stopTranscription(sessionId) {
  console.log(`[Transcription] Stopping all connections for session ${sessionId}`);
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
    if (connData.groupAnalysisInterval) clearInterval(connData.groupAnalysisInterval);
    try { connData.connection.finish(); } catch (e) {}
    activeConnections.delete(key);
  }

  recentUtterances.delete(sessionId);
  sessionState.delete(sessionId);
  console.log(`[Transcription] All connections closed for session ${sessionId}`);
}

function startTranscription(sessionId) {
  console.log(`[Transcription] Session ${sessionId} ready — connections open on first audio`);
  getSessionState(sessionId);
}

module.exports = { sendAudioChunk, startTranscription, stopTranscription };
