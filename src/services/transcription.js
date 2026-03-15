const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('./supabase');
const { retrieveRelevantChunks } = require('./rag');

const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const activeConnections = new Map();
const sessionState = new Map();
const recentUtterances = new Map();

const DEDUP_WINDOW_MS = 3000;
const DEDUP_SIMILARITY = 0.85;

// ─── Minimum gap between ANY prompt (group or individual) ─────────────────────
// Prevents flooding. After a prompt fires, nothing fires for 60s.
const PROMPT_COOLDOWN_MS = 60000;

// ─── Minimum utterances before we attempt analysis ────────────────────────────
const MIN_UTTERANCES_FOR_ANALYSIS = 4;

function getSessionState(sessionId) {
  if (!sessionState.has(sessionId)) {
    sessionState.set(sessionId, {
      topic: null,
      sessionConfig: {},
      participantStats: {},
      recentTranscript: [],     // { speaker, text, timestamp } — last 40 utterances
      utteranceBuffer: {},
      firedPrompts: [],         // all prompts fired this session for dedup/report
      lastPromptAt: 0,          // timestamp of last prompt fired (any type)
      analysisInterval: null,
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
      else { return true; }
    }
  }
  fresh.push({ text: utterance, participantName, timestamp: now, snr: currentSNR });
  return false;
}

// ─── Unified context-aware prompt engine ─────────────────────────────────────
//
// This is the single place where ALL prompts are decided. It runs every 60s.
// Claude reads:
//   - Full recent transcript (last 20 utterances)
//   - Participation stats (who spoke, how much)
//   - Relevant material chunks from RAG
//   - Session objectives
//   - Professor's configured prompts (as reference/options, not fixed)
//   - Already-fired prompts (to avoid repeats)
//
// Claude decides:
//   A) No intervention needed — say nothing
//   B) Individual nudge needed — targeted to one student, personal card
//   C) Group prompt needed — broadcast to all, from professor list or Claude-generated
//
// The 60s cooldown applies to ALL outcomes B and C combined.
//
async function analyseAndPrompt(sessionId) {
  const state = getSessionState(sessionId);
  if (!state) return;

  // Not enough data yet
  if (state.recentTranscript.length < MIN_UTTERANCES_FOR_ANALYSIS) return;
  if (Object.keys(state.participantStats).length === 0) return;

  const now = Date.now();

  // Enforce cooldown — if we fired anything recently, skip
  if (now - state.lastPromptAt < PROMPT_COOLDOWN_MS) return;

  const { broadcastToSession, sendToParticipant, broadcastToAdmins } = require('./websocket');

  // Pull material context relevant to recent conversation
  const recentText = state.recentTranscript.slice(-8).map(u => u.text).join(' ');
  let materialContext = '';
  try {
    const chunks = await retrieveRelevantChunks(sessionId, recentText, 4);
    if (chunks.length > 0) {
      materialContext = `Relevant course material the students should be engaging with:\n${chunks.map((c, i) => `[${i+1}] ${c}`).join('\n\n')}`;
    }
  } catch (e) {}

  const objectives = (state.sessionConfig?.objectives || []).filter(o => o.trim());
  const professorPrompts = (state.sessionConfig?.discussion_prompts || []).filter(p => p.trim());
  const interventionRules = state.sessionConfig?.interventions || {};

  // Build participation summary with timing
  const participantList = Object.entries(state.participantStats)
    .map(([name, s]) => {
      const lastSpoke = state.recentTranscript.filter(u => u.speaker === name).slice(-1)[0];
      const secondsSinceSpoke = lastSpoke ? Math.round((now - lastSpoke.timestamp) / 1000) : null;
      return `${name}: ${s.utteranceCount} contributions, ~${Math.round(s.talkTimeSeconds)}s talk time${secondsSinceSpoke !== null ? `, last spoke ${secondsSinceSpoke}s ago` : ''}`;
    }).join('\n');

  // Recent transcript window
  const transcriptWindow = state.recentTranscript.slice(-20)
    .map(u => `[${u.speaker}]: ${u.text}`)
    .join('\n');

  // What's been fired already
  const recentlyFired = state.firedPrompts.slice(-6)
    .map(f => `"${f.prompt.slice(0, 80)}" → ${f.target} (${Math.round((now - f.timestamp) / 1000)}s ago)`)
    .join('\n');

  // Professor's configured prompts as options
  const professorPromptsText = professorPrompts.length > 0
    ? `Professor's discussion prompts (use these verbatim or as inspiration — pick the most contextually relevant):\n${professorPrompts.map((p, i) => `${i+1}. ${p}`).join('\n')}`
    : '';

  // Enabled intervention rules
  const enabledInterventions = Object.entries(interventionRules)
    .filter(([, cfg]) => cfg?.enabled && cfg?.prompt)
    .map(([key, cfg]) => `${key}: "${cfg.prompt}"`)
    .join('\n');

  const systemPrompt = `You are an AI facilitator monitoring a live university seminar discussion. Your role is to improve discussion quality — deepening thinking, ensuring participation, keeping focus on the topic and learning objectives.

You have two tools:
1. INDIVIDUAL nudge — sent privately to one student whose contribution needs improvement
2. GROUP prompt — sent to everyone, used to deepen the whole discussion or redirect it

Use these SPARINGLY. Only intervene when there is a clear, specific reason. A good discussion should flow for several minutes without intervention.`;

  const userPrompt = `Session topic: ${state.topic || 'Academic discussion'}
${objectives.length > 0 ? `\nLearning objectives:\n${objectives.map((o, i) => `${i+1}. ${o}`).join('\n')}` : ''}

${materialContext ? materialContext + '\n' : ''}
Current participation:
${participantList}

Recent conversation:
${transcriptWindow}

${recentlyFired ? `Already fired (do not repeat or send something too similar):\n${recentlyFired}\n` : ''}
${professorPromptsText ? `\n${professorPromptsText}\n` : ''}
${enabledInterventions ? `\nConfigured intervention prompts:\n${enabledInterventions}\n` : ''}

Analyse this discussion carefully. Ask yourself:
- Is someone genuinely silent and disengaged (not just listening)?
- Is the quality of reasoning shallow — agreement without analysis, summarising without evaluation?
- Is the discussion drifting away from the topic or objectives?
- Is someone dominating in a way that prevents others from contributing?
- Would a specific discussion prompt from the professor's list significantly deepen the conversation right now?
- OR is the discussion actually going well and needs no intervention?

DECISION RULES:
- If the discussion is flowing well — return no_action
- Individual nudge: only for a student who is CLEARLY disengaged or whose contributions are consistently shallow
- Group prompt: when the WHOLE discussion needs to go deeper, change direction, or engage with a specific concept from the material
- If using professor's prompts, pick the one most relevant to what was JUST discussed
- The prompt text must feel like a natural continuation of the conversation — it should reference what was actually just said
- Never send the same or similar prompt twice

Respond ONLY with one of these JSON formats, no markdown:

{"action":"no_action"}

{"action":"individual","target":"<exact participant name>","prompt":"<prompt text contextually relevant to their recent contributions>","type":"<SILENT|SHALLOW|OFF_TOPIC|DOMINATING>","reasoning":"<one sentence>"}

{"action":"group","prompt":"<prompt text>","type":"<DEEPENING|REDIRECT|ENGAGEMENT>","reasoning":"<one sentence>"}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 350,
      messages: [
        { role: 'user', content: systemPrompt + '\n\n' + userPrompt }
      ],
    });

    const text = response.content?.[0]?.text?.trim();
    if (!text) return;

    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    if (!result.action || result.action === 'no_action') {
      console.log(`[Prompt Engine] No action needed for session ${sessionId}`);
      return;
    }

    // Final cooldown check
    if (Date.now() - state.lastPromptAt < PROMPT_COOLDOWN_MS) return;

    state.lastPromptAt = Date.now();
    const promptRecord = {
      action: result.action,
      target: result.target || 'group',
      prompt: result.prompt,
      type: result.type,
      reasoning: result.reasoning,
      timestamp: Date.now(),
    };
    state.firedPrompts.push(promptRecord);
    if (state.firedPrompts.length > 20) state.firedPrompts.shift();

    if (result.action === 'individual') {
      console.log(`[Prompt Engine] Individual → ${result.target} (${result.type}): "${result.prompt.slice(0, 60)}..."`);
      sendToParticipant(sessionId, result.target, 'AI_PROMPT', {
        target: result.target,
        prompt: result.prompt,
        type: result.type,
      });

      // Notify admin
      broadcastToAdmins(sessionId, 'INTERVENTION_FIRED', {
        target: result.target,
        type: result.type,
        prompt: result.prompt,
        reasoning: result.reasoning,
        timestamp: new Date().toISOString(),
      });

    } else if (result.action === 'group') {
      console.log(`[Prompt Engine] Group (${result.type}): "${result.prompt.slice(0, 60)}..."`);
      broadcastToSession(sessionId, 'GENERAL_PROMPT', {
        prompt: result.prompt,
        target: 'group',
        type: result.type,
      });

      broadcastToAdmins(sessionId, 'GENERAL_PROMPT_FIRED', {
        prompt: result.prompt,
        type: result.type,
        reasoning: result.reasoning,
        timestamp: new Date().toISOString(),
      });
    }

    // Log to DB for report
    await supabase.from('prompts_log').insert({
      session_id: sessionId,
      target: result.target || 'group',
      prompt_text: result.prompt,
      prompt_type: result.type || result.action,
      issued_by: 'ai_engine',
    }).catch(() => {});

  } catch (err) {
    console.error('[Prompt Engine] Error:', err.message);
  }
}

// ─── Deepgram connection management ──────────────────────────────────────────

async function ensureConnection(sessionId, participantName) {
  const key = getConnectionKey(sessionId, participantName);
  if (activeConnections.has(key)) return activeConnections.get(key);

  console.log(`[Deepgram] Opening connection for ${participantName} in session ${sessionId}`);

  const connData = {
    connection: null, buffer: [], isOpen: false,
    keepAliveInterval: null,
  };
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

    // Start analysis loop on first connection for this session only
    const allKeys = [...activeConnections.keys()].filter(k => k.startsWith(sessionId + '::'));
    if (allKeys.length === 1) {
      const state = getSessionState(sessionId);
      state.analysisInterval = setInterval(() => {
        analyseAndPrompt(sessionId).catch(err =>
          console.error('[Prompt Engine] Interval error:', err.message)
        );
      }, 60000);
      console.log(`[Prompt Engine] Analysis loop started for session ${sessionId}`);
    }
  });

  connection.on(LiveTranscriptionEvents.Transcript, async (data) => {
    const alt = data?.channel?.alternatives?.[0];
    if (!alt || !alt.transcript || alt.transcript.trim() === '') return;
    if (data.is_final === false) return;

    const utterance = alt.transcript.trim();
    if (utterance.split(' ').length < 3) return;

    const speakerTag = participantName;
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

    state.recentTranscript.push({ speaker: speakerTag, text: utterance, timestamp: Date.now() });
    if (state.recentTranscript.length > 40) state.recentTranscript.shift();

    const { broadcastToAdmins } = require('./websocket');
    broadcastToAdmins(sessionId, 'NEW_UTTERANCE', {
      speakerTag, utterance, timestamp: new Date().toISOString(),
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
    activeConnections.delete(key);
  });

  return connData;
}

async function scoreAndBroadcast(sessionId, state, speakerTag, batch) {
  try {
    const { scoreUtterance } = require('./scoring');
    const { broadcastToAdmins } = require('./websocket');
    const scoreResult = await scoreUtterance(sessionId, speakerTag, batch, state.topic, state.sessionConfig);
    if (!scoreResult) return;
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
        bloom_level: bloomLevel,
        utterance_count: n + 1,
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
    if (connData.isOpen) { connData.connection.send(chunk); }
    else { connData.buffer.push(chunk); }
  } catch (err) {
    console.error(`[Audio] Chunk error for ${participantName}:`, err.message);
  }
}

async function stopTranscription(sessionId) {
  console.log(`[Transcription] Stopping all connections for session ${sessionId}`);
  const keysToClose = [...activeConnections.keys()].filter(k => k.startsWith(sessionId + '::'));

  // Stop analysis interval
  const state = sessionState.get(sessionId);
  if (state?.analysisInterval) {
    clearInterval(state.analysisInterval);
    state.analysisInterval = null;
  }

  for (const key of keysToClose) {
    const connData = activeConnections.get(key);
    if (!connData) continue;
    const participantName = key.split('::')[1];
    const s = getSessionState(sessionId);
    if (s.utteranceBuffer[participantName]?.length > 0) {
      const batch = s.utteranceBuffer[participantName].join(' ');
      s.utteranceBuffer[participantName] = [];
      await scoreAndBroadcast(sessionId, s, participantName, batch);
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
  // No timer scheduling here — analysis loop starts when first participant connects
}

function getSessionStats(sessionId) {
  const state = sessionState.get(sessionId);
  return state?.participantStats || {};
}

function getInterventionLog(sessionId) {
  const state = sessionState.get(sessionId);
  return state?.firedPrompts || [];
}

module.exports = { sendAudioChunk, startTranscription, stopTranscription, getSessionStats, getInterventionLog };
