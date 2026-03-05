const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { scoreUtterance, analyseGroupState } = require('./scoring');
const { broadcastToAdmins, broadcastToSession } = require('./websocket');
const supabase = require('./supabase');

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// Active transcription sessions: sessionId -> { connection, buffer, stats }
const activeSessions = new Map();

async function startTranscription(sessionId, topic) {
  if (activeSessions.has(sessionId)) return;

  const connection = deepgram.listen.live({
    model: 'nova-2',
    language: 'en',
    smart_format: true,
    diarize: true,
    punctuate: true,
    utterance_end_ms: 1500,
    interim_results: true,
  });

  const sessionData = {
    connection,
    topic,
    participantStats: {},    // speakerName -> { talkTimeSeconds, utteranceCount }
    recentTranscript: [],    // last 10 utterances for group analysis
    lastGroupCheck: Date.now(),
    groupCheckInterval: 90000, // check group state every 90 seconds
  };

  activeSessions.set(sessionId, sessionData);

  connection.on(LiveTranscriptionEvents.Open, () => {
    console.log(`[Deepgram] Transcription started for session ${sessionId}`);
  });

  connection.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const transcript = data.channel?.alternatives?.[0];
    if (!transcript || !transcript.transcript || data.is_final === false) return;

    const words = transcript.words || [];
    if (words.length === 0) return;

    // Map Deepgram speaker IDs to names (speaker_0, speaker_1, etc.)
    const speakerTag = `Speaker ${(words[0]?.speaker ?? 0) + 1}`;
    const utterance = transcript.transcript.trim();
    const duration = words.length > 1
      ? (words[words.length - 1].end - words[0].start)
      : 1;

    // Update participation stats
    if (!sessionData.participantStats[speakerTag]) {
      sessionData.participantStats[speakerTag] = { talkTimeSeconds: 0, utteranceCount: 0 };
    }
    sessionData.participantStats[speakerTag].talkTimeSeconds += duration;
    sessionData.participantStats[speakerTag].utteranceCount += 1;

    // Store in DB
    const { data: savedUtterance } = await supabase.from('transcripts').insert({
      session_id: sessionId,
      speaker_name: speakerTag,
      utterance,
      timestamp_seconds: words[0]?.start ?? 0,
    }).select().single();

    // Update recent transcript buffer
    sessionData.recentTranscript.push(`[${speakerTag}]: ${utterance}`);
    if (sessionData.recentTranscript.length > 10) sessionData.recentTranscript.shift();

    // Broadcast new utterance to admin dashboard
    broadcastToAdmins(sessionId, 'NEW_UTTERANCE', {
      speakerTag,
      utterance,
      timestamp: new Date().toISOString(),
    });

    // Score utterance (async, don't await to keep stream flowing)
    scoreAndBroadcast(sessionId, sessionData, speakerTag, utterance);

    // Periodic group analysis
    const now = Date.now();
    if (now - sessionData.lastGroupCheck > sessionData.groupCheckInterval) {
      sessionData.lastGroupCheck = now;
      runGroupAnalysis(sessionId, sessionData);
    }
  });

  connection.on(LiveTranscriptionEvents.Error, (err) => {
    console.error(`[Deepgram] Error for session ${sessionId}:`, err);
  });

  connection.on(LiveTranscriptionEvents.Close, () => {
    console.log(`[Deepgram] Connection closed for session ${sessionId}`);
    activeSessions.delete(sessionId);
  });

  return connection;
}

async function scoreAndBroadcast(sessionId, sessionData, speakerTag, utterance) {
  try {
    const result = await scoreUtterance({
      sessionId,
      topic: sessionData.topic,
      speakerName: speakerTag,
      utterance,
      conversationContext: sessionData.recentTranscript.join('\n'),
    });

    // Update cumulative score in DB
    await updateParticipantScore(sessionId, speakerTag, result, sessionData.participantStats[speakerTag]);

    // Broadcast score update to admin
    broadcastToAdmins(sessionId, 'SCORE_UPDATE', {
      speakerTag,
      scores: result,
      participationStats: sessionData.participantStats[speakerTag],
    });

    // If a flag was raised, broadcast prompt suggestion to admin
    if (result.flag && result.suggested_prompt) {
      broadcastToAdmins(sessionId, 'PROMPT_SUGGESTION', {
        target: speakerTag,
        flag: result.flag,
        prompt: result.suggested_prompt,
        reasoning: result.reasoning,
      });
    }
  } catch (err) {
    console.error('[Transcription] Score error:', err);
  }
}

async function runGroupAnalysis(sessionId, sessionData) {
  try {
    const result = await analyseGroupState({
      sessionId,
      topic: sessionData.topic,
      participantStats: sessionData.participantStats,
      recentTranscript: sessionData.recentTranscript.join('\n'),
    });

    if (result.intervention_needed) {
      broadcastToAdmins(sessionId, 'GROUP_INTERVENTION', {
        type: result.type,
        target: result.target,
        prompt: result.prompt,
        reasoning: result.reasoning,
      });
    }
  } catch (err) {
    console.error('[Transcription] Group analysis error:', err);
  }
}

async function updateParticipantScore(sessionId, speakerTag, scoreResult, participationStats) {
  try {
    // Calculate participation score (0-10) based on talk time equity
    const totalTalkTime = Object.values(
      activeSessions.get(sessionId)?.participantStats ?? {}
    ).reduce((sum, s) => sum + s.talkTimeSeconds, 0);

    const fairShare = totalTalkTime / Math.max(
      Object.keys(activeSessions.get(sessionId)?.participantStats ?? {}).length, 1
    );
    const actualShare = participationStats.talkTimeSeconds;
    const participationScore = Math.min(10, Math.round((actualShare / Math.max(fairShare, 1)) * 7));

    // Upsert score
    const { data: existing } = await supabase
      .from('scores')
      .select('id, topic_adherence_score, depth_score, material_application_score, overall_score')
      .eq('session_id', sessionId)
      .eq('speaker_tag', speakerTag)
      .single();

    if (existing) {
      // Rolling average
      const avg = (old, newVal) => Math.round((old * 0.7 + newVal * 0.3) * 10) / 10;
      await supabase.from('scores').update({
        participation_score: participationScore,
        topic_adherence_score: avg(existing.topic_adherence_score, scoreResult.topic_adherence),
        depth_score: avg(existing.depth_score, scoreResult.depth),
        material_application_score: avg(existing.material_application_score, scoreResult.material_application),
        overall_score: avg(existing.overall_score,
          (scoreResult.topic_adherence + scoreResult.depth + scoreResult.material_application * 1.5) / 3.5
        ),
        updated_at: new Date().toISOString(),
      }).eq('id', existing.id);
    } else {
      const overall = (scoreResult.topic_adherence + scoreResult.depth + scoreResult.material_application * 1.5) / 3.5;
      await supabase.from('scores').insert({
        session_id: sessionId,
        speaker_tag: speakerTag,
        participation_score: participationScore,
        topic_adherence_score: scoreResult.topic_adherence,
        depth_score: scoreResult.depth,
        material_application_score: scoreResult.material_application,
        overall_score: overall,
      });
    }
  } catch (err) {
    console.error('[Transcription] Score update error:', err);
  }
}

function sendAudioChunk(sessionId, audioChunk) {
  const session = activeSessions.get(sessionId);
  if (session?.connection) {
    session.connection.send(audioChunk);
  }
}

async function stopTranscription(sessionId) {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.connection.finish();
    activeSessions.delete(sessionId);
  }
}

function getSessionStats(sessionId) {
  return activeSessions.get(sessionId)?.participantStats ?? {};
}

module.exports = { startTranscription, sendAudioChunk, stopTranscription, getSessionStats };
