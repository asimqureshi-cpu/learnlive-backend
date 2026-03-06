const { createClient } = require('@deepgram/sdk');
const { broadcastToAdmins } = require('./websocket');
const supabase = require('./supabase');

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const activeSessions = new Map();

async function startTranscription(sessionId, topic) {
  if (activeSessions.has(sessionId)) return;
  console.log('[Deepgram] Starting transcription for session', sessionId);

  try {
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
      lastGroupCheck: Date.now(),
    };

    activeSessions.set(sessionId, sessionData);

    connection.on('open', () => {
      console.log('[Deepgram] Connection open for session', sessionId);
    });

    connection.on('transcript', async (data) => {
      const alt = data?.channel?.alternatives?.[0];
      if (!alt || !alt.transcript || alt.transcript.trim() === '') return;

      const utterance = alt.transcript.trim();
      const speakerTag = 'Speaker ' + ((data?.channel?.alternatives?.[0]?.words?.[0]?.speaker ?? 0) + 1);

      console.log('[Deepgram] Transcript:', speakerTag, '-', utterance);

      // Store in DB
      await supabase.from('transcripts').insert({
        session_id: sessionId,
        speaker_name: speakerTag,
        utterance,
        timestamp_seconds: 0,
      });

      // Update stats
      if (!sessionData.participantStats[speakerTag]) {
        sessionData.participantStats[speakerTag] = { talkTimeSeconds: 0, utteranceCount: 0 };
      }
      sessionData.participantStats[speakerTag].utteranceCount += 1;
      sessionData.participantStats[speakerTag].talkTimeSeconds += utterance.split(' ').length * 0.4;

      sessionData.recentTranscript.push('[' + speakerTag + ']: ' + utterance);
      if (sessionData.recentTranscript.length > 10) sessionData.recentTranscript.shift();

      // Broadcast to admin dashboard
      broadcastToAdmins(sessionId, 'NEW_UTTERANCE', {
        speakerTag,
        utterance,
        timestamp: new Date().toISOString(),
      });

      // Score asynchronously
      scoreAndBroadcast(sessionId, sessionData, speakerTag, utterance);
    });

    connection.on('error', (err) => {
      console.error('[Deepgram] Error:', err);
    });

    connection.on('close', () => {
      console.log('[Deepgram] Connection closed for session', sessionId);
      activeSessions.delete(sessionId);
    });

  } catch (err) {
    console.error('[Deepgram] Failed to start:', err);
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
    console.error('[Scoring] Error:', err);
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
    console.error('[Score Update] Error:', err);
  }
}

function sendAudioChunk(sessionId, audioChunk) {
  const session = activeSessions.get(sessionId);
  if (session && session.connection) {
    try {
      session.connection.send(audioChunk);
    } catch (err) {
      console.error('[Deepgram] Send error:', err.message);
    }
  } else {
    console.log('[Deepgram] No active session for', sessionId);
  }
}

async function stopTranscription(sessionId) {
  const session = activeSessions.get(sessionId);
  if (session) {
    try { session.connection.finish(); } catch (e) {}
    activeSessions.delete(sessionId);
  }
}

function getSessionStats(sessionId) {
  return activeSessions.get(sessionId)?.participantStats ?? {};
}

module.exports = { startTranscription, sendAudioChunk, stopTranscription, getSessionStats };
```

Commit → wait for Railway green → start a fresh session → join → speak → check Deploy Logs. You should now see:
```
[Deepgram] Connection open for session xxx
[Deepgram] Transcript: Speaker 1 - your words here
