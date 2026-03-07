const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const supabase = require('./supabase');

const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);

// Map key: `${sessionId}::${participantName}` → per-participant connection data
const activeConnections = new Map();

// Session-level shared state: scores, stats, transcript buffer
const sessionState = new Map();

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

// Called when a participant's first audio chunk arrives
async function ensureConnection(sessionId, participantName) {
  const key = getConnectionKey(sessionId, participantName);
  if (activeConnections.has(key)) return activeConnections.get(key);

  console.log(`[Deepgram] Opening connection for ${participantName} in session ${sessionId}`);

  // Fetch session topic once per session
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

    // Flush buffered chunks
    if (connData.buffer.length > 0) {
      console.log(`[Deepgram] Flushing ${connData.buffer.length} buffered chunks for ${participantName}`);
      connData.buffer.forEach(chunk => connection.send(chunk));
      connData.buffer = [];
    }

    connData.keepAliveInterval = setInterval(() => {
      try { connection.keepAlive(); } catch (e) {}
    }, 8000);

    // Group analysis every 60s — only run on first participant's connection to avoid duplicates
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
    if (utterance.split(' ').length < 5) {
      console.log(`[Deepgram] Skipping short utterance: ${utterance}`);
      return;
    }

    // Use participant name directly — no diarization needed
    const speakerTag = participantName;
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

    // Buffer utterances — score in batches of 3
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

// Called from websocket.js for every audio chunk
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

// Called when session ends — flush buffers and close all connections for session
async function stopTranscription(sessionId) {
  console.log(`[Transcription] Stopping all connections for session ${sessionId}`);
  const keysToClose = [...activeConnections.keys()].filter(k => k.startsWith(sessionId + '::'));

  for (const key of keysToClose) {
    const connData = activeConnections.get(key);
    if (!connData) continue;
    const participantName = key.split('::')[1];

    // Flush remaining buffer
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

  sessionState.delete(sessionId);
  console.log(`[Transcription] All connections closed for session ${sessionId}`);
}

// Legacy — kept for compatibility in case called without participantName
function startTranscription(sessionId) {
  console.log(`[Transcription] Session ${sessionId} ready — connections open on first audio`);
  getSessionState(sessionId);
}

module.exports = { sendAudioChunk, startTranscription, stopTranscription };
