const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { broadcastToAdmins } = require('./websocket');
const supabase = require('./supabase');

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// sessionId -> { topic, connection, keepAliveInterval, participantStats, recentTranscript }
const activeSessions = new Map();
// sessionId -> { topic } — sessions registered but waiting for first audio chunk
const pendingSessions = new Map();

function registerSession(sessionId, topic) {
  console.log('[Transcription] Session registered, waiting for audio:', sessionId);
  pendingSessions.set(sessionId, { topic });
}

function openDeepgramConnection(sessionId, topic) {
  if (activeSessions.has(sessionId)) return activeSessions.get(sessionId);
  console.log('[Deepgram] Opening connection for session', sessionId);

  const connection = deepgram.listen.live({
    model: 'nova-2',
    language: 'en',
    smart_format: true,
    interim_results: false,
    endpointing: 300,
  });

  const sessionData = {
    connection,
    topic,
    participantStats: {},
    recentTranscript: [],
    keepAliveInterval: null,
  };

  activeSessions.set(sessionId, sessionData);

  connection.on(LiveTranscriptionEvents.Open, () => {
    console.log('[Deepgram] Connection open for session', sessionId);
    // Send keepAlive every 8 seconds to prevent 10s timeout
    sessionData.keepAliveInterval = setInterval(() => {
      try {
        connection.keepAlive();
      } catch (e) {}
    }, 8000);
  });

  connection.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const alt = data?.channel?.alternatives?.[0];
    if (!alt || !alt.transcript || alt.transcript.trim() === '') return;

    const utterance = alt.transcript.trim();
    const speakerIdx = data?.channel?.alternatives?.[0]?.words?.[0]?.speaker ?? 0;
    const speakerTag = 'Speaker ' + (speakerIdx + 1);

    console.log('[Deepgram] Transcript:', speakerTag, '-', utterance);

    await supabase.from('transcripts').insert({
      session_id: sessionId,
      speaker_name: speakerTag,
      utterance,
      timestamp_seconds: 0,
    });

    if (!sessionData.participantStats[speakerTag]) {
      sessionData.participantStats[speakerTag] = { talkTimeSeconds: 0, utteranceCount: 0 };
    }
    sessionData.participantStats[speakerTag].utteranceCount += 1;
    sessionData.participantStats[speakerTag].talkTimeSeconds += utterance.split(' ').length * 0.4;

    sessionData.recentTranscript.push('[' + speakerTag + ']: ' + utterance);
    if (sessionData.recentTranscript.length > 10) sessionData.recentTranscript.shift();

    broadcastToAdmins(sessionId, 'NEW_UTTERANCE', {
      speakerTag,
      utterance,
      timestamp: new Date().toISOString(),
    });

    scoreAndBroadcast(sessionId, sessionData, speakerTag, utterance);
  });

  connection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error('[Deepgram] Error for session', sessionId, ':', err.message || err);
  });

  connection.on(LiveTranscriptionEvents.Close, () => {
    console.log('[Deepgram] Connection closed for session', sessionId);
    if (sessionData.keepAliveInterval) clearInterval(sessionData.keepAliveInterval);
    activeSessions.delete(sessionId);
  });

  return sessionData;
}

function sendAudioChunk(sessionId, audioChunk) {
  // If this is the first audio, open Deepgram connection now
  if (!activeSessions.has(sessionId)) {
    const pending = pendingSessions.get(sessionId);
    if (!pending) {
      console.log('[Deepgram] No session registered for', sessionId);
      return;
    }
    pendingSessions.delete(sessionId);
    openDeepgramConnection(sessionId, pending.topic);
  }

  const session = activeSessions.get(sessionId);
  if (!session) return;

  try {
    const state = session.connection.getReadyState();
    if (state === 1) {
      session.connection.send(audioChunk);
    }
  } catch (err) {
    console.error('[Deepgram] Send error:', err.message);
  }
}

async function scoreAndBroadcast(sessionId, sessionData, speakerTag, utterance) {
  try {
    const { scoreUtterance } = require('./scoring');
    const result = await scoreUtterance({
      sessionId,
      topic: sessionData.topic,
      speakerName: speakerTag,
      utterance,
      conversationContext: sessionData.recentTranscript.join('\n'),
    });

    await updateParticipantScore(sessionId, speakerTag, result, sessionData.participantStats[speakerTag]);

    broadcastToAdmins(sessionId, 'SCORE_UPDATE', {
      speakerTag,
      scores: result,
      participationStats: sessionData.participantStats[speakerTag],
    });

    if (result.flag && result.suggested_prompt) {
      broadcastToAdmins(sessionId, 'PROMPT_SUGGESTION', {
        target: speakerTag,
        flag: result.flag,
        prompt: result.suggested_prompt,
        reasoning: result.reasoning,
      });
    }
  } catch (err) {
    console.error('[Scoring] Error:', err.message);
  }
}

async function updateParticipantScore(sessionId, speakerTag, scoreResult, participationStats) {
  try {
    const overall = (scoreResult.topic_adherence + scoreResult.depth + scoreResult.material_application * 1.5) / 3.5;
    const { data: existing } = await supabase
      .from('scores').select('*').eq('session_id', sessionId).eq('speaker_tag', speakerTag).single();

    if (existing) {
      const avg = (o, n) => Math.round((o * 0.7 + n * 0.3) * 10) / 10;
      await supabase.from('scores').update({
        topic_adherence_score: avg(existing.topic_adherence_score, scoreResult.topic_adherence),
        depth_score: avg(existing.depth_score, scoreResult.depth),
        material_application_score: avg(existing.material_application_score, scoreResult.material_application),
        overall_score: avg(existing.overall_score, overall),
        updated_at: new Date().toISOString(),
      }).eq('id', existing.id);
    } else {
      await supabase.from('scores').insert({
        session_id: sessionId,
        speaker_tag: speakerTag,
        participation_score: 5,
        topic_adherence_score: scoreResult.topic_adherence,
        depth_score: scoreResult.depth,
        material_application_score: scoreResult.material_application,
        overall_score: overall,
      });
    }
  } catch (err) {
    console.error('[Score Update] Error:', err.message);
  }
}

async function startTranscription(sessionId, topic) {
  registerSession(sessionId, topic);
  return { success: true };
}

async function stopTranscription(sessionId) {
  pendingSessions.delete(sessionId);
  const session = activeSessions.get(sessionId);
  if (session) {
    if (session.keepAliveInterval) clearInterval(
