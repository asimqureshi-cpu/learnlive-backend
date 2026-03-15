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

// ─── Session phases (as % of total duration) ─────────────────────────────────
const PHASE = {
  JOIN_WINDOW:   { start: 0,   end: 5   },  // 0–5%:  join, no nudges, send opening Q on connect
  WARMUP:        { start: 5,   end: 15  },  // 5–15%: light prompts only, get everyone talking
  MAIN:          { start: 15,  end: 75  },  // 15–75%: full nudge + prompt engine
  DEEPENING:     { start: 75,  end: 90  },  // 75–90%: quality focus, no participation nudges
  CLOSE:         { start: 90,  end: 100 },  // 90–100%: wrap-up prompt, no nudges
};

// ─── Nudge thresholds ─────────────────────────────────────────────────────────
const SILENCE_LAYER1_MS = 90 * 1000;         // 90s silence → Layer 1 nudge
const SHALLOW_BATCHES_THRESHOLD = 2;          // 2 consecutive shallow batches → nudge
const LOW_TOPIC_ADHERENCE = 4;                // below 4/10 topic adherence → off-topic nudge
const MAX_NUDGES_PER_STUDENT = 2;             // max nudges per student per session
const LAYER2_COOLDOWN_MS = 3 * 60 * 1000;    // 3 min between Layer 2 nudges per student
const GROUP_PROMPT_COOLDOWN_MS = 3 * 60 * 1000; // 3 min between group prompts

function getSessionState(sessionId) {
  if (!sessionState.has(sessionId)) {
    sessionState.set(sessionId, {
      topic: null,
      sessionConfig: {},
      openingQuestion: null,         // stored so late joiners can receive it
      sessionStartedAt: null,        // set when startTranscription is called
      participantStats: {},          // { [name]: { utteranceCount, talkTimeSeconds } }
      recentTranscript: [],          // last 40 { speaker, text, timestamp, scores }
      utteranceBuffer: {},
      firedPrompts: [],              // all prompts/nudges fired this session
      lastGroupPromptAt: 0,
      studentState: {},              // per-student nudge state (see initStudentState)
      analysisInterval: null,
    });
  }
  return sessionState.get(sessionId);
}

function initStudentState() {
  return {
    nudgeCount: 0,
    layer1FiredAt: null,
    layer2FiredAt: null,
    maxNudgesReached: false,
    lastSpokeAt: null,
    recentBatchScores: [],     // last 3 batch overall scores
    recentTopicScores: [],     // last 3 topic_adherence scores
    consecutiveShallowBatches: 0,
  };
}

function getStudentState(state, name) {
  if (!state.studentState[name]) state.studentState[name] = initStudentState();
  return state.studentState[name];
}

// Returns session elapsed % (0–100)
function getSessionPct(state) {
  if (!state.sessionStartedAt) return 0;
  const durationMs = (state.sessionConfig?.duration_minutes || 60) * 60 * 1000;
  const elapsed = Date.now() - state.sessionStartedAt;
  return Math.min(100, (elapsed / durationMs) * 100);
}

function getCurrentPhase(pct) {
  if (pct < PHASE.JOIN_WINDOW.end) return 'JOIN_WINDOW';
  if (pct < PHASE.WARMUP.end) return 'WARMUP';
  if (pct < PHASE.MAIN.end) return 'MAIN';
  if (pct < PHASE.DEEPENING.end) return 'DEEPENING';
  return 'CLOSE';
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

// ─── PROMPT SCHEDULER ─────────────────────────────────────────────────────────
// Pure logic — no Claude call. Fires professor's discussion prompts to the group
// based on session phase and timing. Completely separate from the nudge engine.
function checkPromptScheduler(sessionId) {
  const state = getSessionState(sessionId);
  if (!state.sessionStartedAt) return;

  const pct = getSessionPct(state);
  const phase = getCurrentPhase(pct);
  const now = Date.now();
  const prompts = (state.sessionConfig?.discussion_prompts || []).filter(p => p.trim());

  if (prompts.length === 0) return;
  if (phase === 'JOIN_WINDOW' || phase === 'CLOSE') return;
  if (now - state.lastGroupPromptAt < GROUP_PROMPT_COOLDOWN_MS) return;

  // Calculate which prompt index should fire based on session percentage
  // Distribute prompts evenly across WARMUP + MAIN + DEEPENING (5%–90%)
  const usableRange = 85; // 90 - 5
  const promptInterval = usableRange / prompts.length;
  const expectedIndex = Math.floor((pct - 5) / promptInterval);
  const clampedIndex = Math.min(expectedIndex, prompts.length - 1);

  // Count how many have already been fired as group prompts
  const firedGroupPrompts = state.firedPrompts.filter(p => p.type === 'GROUP_PROMPT').length;

  if (firedGroupPrompts <= clampedIndex) {
    const prompt = prompts[firedGroupPrompts];
    if (!prompt) return;

    const { broadcastToSession, broadcastToAdmins } = require('./websocket');
    console.log(`[Prompt Scheduler] Phase ${phase} (${pct.toFixed(0)}%) — firing prompt ${firedGroupPrompts + 1}/${prompts.length}`);

    broadcastToSession(sessionId, 'GENERAL_PROMPT', {
      prompt,
      target: 'group',
      type: 'GROUP_PROMPT',
      index: firedGroupPrompts + 1,
      total: prompts.length,
    });

    broadcastToAdmins(sessionId, 'GENERAL_PROMPT_FIRED', {
      prompt,
      index: firedGroupPrompts + 1,
      total: prompts.length,
      phase,
      timestamp: new Date().toISOString(),
    });

    state.lastGroupPromptAt = now;
    state.firedPrompts.push({ type: 'GROUP_PROMPT', prompt, target: 'group', timestamp: now });

    supabase.from('prompts_log').insert({
      session_id: sessionId, target: 'group',
      prompt_text: prompt, prompt_type: 'scheduled_group', issued_by: 'system',
    }).then().catch(() => {});
  }
}

// ─── NUDGE ENGINE ─────────────────────────────────────────────────────────────
// Condition-gated. Claude is only called when a specific student has crossed
// a measurable threshold. Layer 1 = no RAG, fast. Layer 2 = RAG + full context.
async function checkNudgeEngine(sessionId) {
  const state = getSessionState(sessionId);
  if (!state.sessionStartedAt) return;

  const pct = getSessionPct(state);
  const phase = getCurrentPhase(pct);
  const now = Date.now();
  const participants = Object.keys(state.participantStats);
  if (participants.length === 0) return;

  // No nudges in JOIN_WINDOW or CLOSE
  if (phase === 'JOIN_WINDOW' || phase === 'CLOSE') return;

  const { sendToParticipant, broadcastToAdmins } = require('./websocket');

  // Calculate fair share of silence — a student silent for 1.5x their fair share needs a nudge
  const elapsedMs = Date.now() - state.sessionStartedAt;
  const fairShareMs = elapsedMs / participants.length;
  const silenceThresholdMs = Math.max(SILENCE_LAYER1_MS, fairShareMs * 1.5);

  for (const name of participants) {
    const stu = getStudentState(state, name);
    if (stu.maxNudgesReached) continue;

    // ── Condition 1: SILENCE ──────────────────────────────────────────────────
    const silentFor = stu.lastSpokeAt ? now - stu.lastSpokeAt : elapsedMs;
    const isSilent = silentFor > silenceThresholdMs;

    // In DEEPENING phase, don't nudge for silence — too late
    if (isSilent && phase !== 'DEEPENING') {
      if (!stu.layer1FiredAt) {
        // Layer 1 — no Claude needed, fire immediately
        await fireNudge(sessionId, name, 'LAYER1_SILENCE', null, state, stu);
        continue;
      } else if (!stu.layer2FiredAt && now - stu.layer1FiredAt > 60000) {
        // Layer 2 — still silent after Layer 1, use Claude + material context
        await fireNudgeLayer2(sessionId, name, 'SILENT', state, stu);
        continue;
      }
    }

    // ── Condition 2: SHALLOW REASONING ───────────────────────────────────────
    // Only in MAIN and DEEPENING phases where quality matters
    if ((phase === 'MAIN' || phase === 'DEEPENING') && stu.consecutiveShallowBatches >= SHALLOW_BATCHES_THRESHOLD) {
      if (!stu.layer1FiredAt || (now - stu.layer1FiredAt > 120000)) {
        await fireNudge(sessionId, name, 'LAYER1_SHALLOW', null, state, stu);
        continue;
      } else if (!stu.layer2FiredAt && now - stu.layer1FiredAt > 90000) {
        await fireNudgeLayer2(sessionId, name, 'SHALLOW', state, stu);
        continue;
      }
    }

    // ── Condition 3: OFF-TOPIC ────────────────────────────────────────────────
    if (phase === 'MAIN' || phase === 'DEEPENING') {
      const recentTopicAvg = stu.recentTopicScores.length > 0
        ? stu.recentTopicScores.reduce((a, b) => a + b, 0) / stu.recentTopicScores.length
        : null;
      if (recentTopicAvg !== null && recentTopicAvg < LOW_TOPIC_ADHERENCE && stu.recentTopicScores.length >= 2) {
        if (!stu.layer1FiredAt || now - stu.layer1FiredAt > 120000) {
          await fireNudge(sessionId, name, 'LAYER1_OFF_TOPIC', null, state, stu);
          continue;
        } else if (!stu.layer2FiredAt && now - stu.layer1FiredAt > 90000) {
          await fireNudgeLayer2(sessionId, name, 'OFF_TOPIC', state, stu);
          continue;
        }
      }
    }
  }

  // ── CLOSE phase: one wrap-up group prompt ─────────────────────────────────
  if (phase === 'CLOSE') {
    const alreadyFiredClose = state.firedPrompts.some(p => p.type === 'CLOSE_PROMPT');
    if (!alreadyFiredClose) {
      const { broadcastToSession } = require('./websocket');
      const closePrompt = "We're in the final minutes. Can someone summarise the key point of disagreement in the group — and what evidence would change your position?";
      broadcastToSession(sessionId, 'GENERAL_PROMPT', {
        prompt: closePrompt, target: 'group', type: 'CLOSE_PROMPT',
      });
      broadcastToAdmins(sessionId, 'GENERAL_PROMPT_FIRED', {
        prompt: closePrompt, type: 'CLOSE_PROMPT', timestamp: new Date().toISOString(),
      });
      state.firedPrompts.push({ type: 'CLOSE_PROMPT', prompt: closePrompt, target: 'group', timestamp: now });
      console.log(`[Nudge Engine] Close prompt fired for session ${sessionId}`);
    }
  }
}

// ─── Layer 1 nudge — no Claude, pure logic, contextually selected ─────────────
async function fireNudge(sessionId, studentName, conditionType, context, state, stu) {
  const interventionRules = state.sessionConfig?.interventions || {};
  const topic = state.topic || 'the topic';
  const { sendToParticipant, broadcastToAdmins } = require('./websocket');

  let prompt;
  let nudgeType;

  if (conditionType === 'LAYER1_SILENCE') {
    nudgeType = 'SILENT';
    // Use professor's configured silence prompt if available, otherwise generate
    const configured = interventionRules.silence?.enabled && interventionRules.silence?.prompt;
    prompt = configured || `We haven't heard from you yet, ${studentName} — what's your initial reaction to this?`;
  } else if (conditionType === 'LAYER1_SHALLOW') {
    nudgeType = 'SHALLOW';
    const configured = interventionRules.shallow?.enabled && interventionRules.shallow?.prompt;
    // Personalise with last utterance if available
    const lastUtterance = state.recentTranscript.filter(u => u.speaker === studentName).slice(-1)[0];
    if (configured) {
      prompt = configured;
    } else if (lastUtterance) {
      prompt = `You mentioned "${lastUtterance.text.slice(0, 60)}..." — can you take that further? What does the framework suggest about why that happens?`;
    } else {
      prompt = `Good start — can you push that analysis a level deeper? What's the underlying mechanism here?`;
    }
  } else if (conditionType === 'LAYER1_OFF_TOPIC') {
    nudgeType = 'OFF_TOPIC';
    const configured = interventionRules.offTopic?.enabled && interventionRules.offTopic?.prompt;
    prompt = configured || `Interesting point — how does that connect back to ${topic}? Try to ground it in the material.`;
  } else {
    return;
  }

  stu.nudgeCount += 1;
  stu.layer1FiredAt = Date.now();
  if (stu.nudgeCount >= MAX_NUDGES_PER_STUDENT) stu.maxNudgesReached = true;

  state.firedPrompts.push({ type: nudgeType, target: studentName, prompt, timestamp: Date.now(), layer: 1 });

  console.log(`[Nudge L1] ${nudgeType} → ${studentName}: "${prompt.slice(0, 60)}..."`);

  sendToParticipant(sessionId, studentName, 'AI_PROMPT', {
    target: studentName, prompt, type: nudgeType,
  });

  broadcastToAdmins(sessionId, 'INTERVENTION_FIRED', {
    target: studentName, type: nudgeType, prompt,
    layer: 1, timestamp: new Date().toISOString(),
  });

  try {
    await supabase.from('prompts_log').insert({
      session_id: sessionId, target: studentName,
      prompt_text: prompt, prompt_type: nudgeType, issued_by: 'ai_layer1',
    });
  } catch (e) {}
}

// ─── Layer 2 nudge — Claude + RAG, contextually grounded ─────────────────────
async function fireNudgeLayer2(sessionId, studentName, conditionType, state, stu) {
  const now = Date.now();

  // Layer 2 cooldown per student
  if (stu.layer2FiredAt && now - stu.layer2FiredAt < LAYER2_COOLDOWN_MS) return;

  const { sendToParticipant, broadcastToAdmins } = require('./websocket');

  // Pull material context relevant to what the student was last discussing
  const studentUtterances = state.recentTranscript.filter(u => u.speaker === studentName).slice(-5);
  const studentText = studentUtterances.map(u => u.text).join(' ');
  let materialContext = '';
  try {
    const chunks = await retrieveRelevantChunks(sessionId, studentText || state.topic, 3);
    if (chunks.length > 0) {
      materialContext = `Relevant material:\n${chunks.map((c, i) => `[${i+1}] ${c}`).join('\n\n')}`;
    }
  } catch (e) {}

  const objectives = (state.sessionConfig?.objectives || []).join('; ');
  const studentTranscriptText = studentUtterances.map(u => `"${u.text}"`).join('\n');
  const professorPrompts = (state.sessionConfig?.discussion_prompts || []).filter(p => p.trim());

  const conditionExplanation = {
    SILENT: `${studentName} has not spoken for an unusually long time despite other discussion happening.`,
    SHALLOW: `${studentName}'s last ${SHALLOW_BATCHES_THRESHOLD} scored contributions were at REMEMBER or UNDERSTAND level — summarising without analysis.`,
    OFF_TOPIC: `${studentName}'s recent contributions have had consistently low topic adherence scores.`,
  }[conditionType];

  const prompt = `You are an AI discussion facilitator. Write a single targeted nudge prompt for one student.

Session topic: ${state.topic}
${objectives ? `Learning objectives: ${objectives}` : ''}

${materialContext}

Student's recent contributions:
${studentTranscriptText || '(none)'}

Condition: ${conditionExplanation}

${professorPrompts.length > 0 ? `Professor's discussion prompts for inspiration (do not copy verbatim):\n${professorPrompts.map((p, i) => `${i+1}. ${p}`).join('\n')}` : ''}

Write ONE nudge prompt for ${studentName} that:
- References something specific from their recent contributions OR from the material
- Pushes them toward APPLY, ANALYSE, or EVALUATE level thinking
- Feels like a natural facilitator question, not a rebuke
- Is 1-2 sentences maximum
- Is directly relevant to the course material shown above

Respond ONLY with the prompt text, no JSON, no preamble.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });

    const nudgeText = response.content?.[0]?.text?.trim();
    if (!nudgeText) return;

    stu.nudgeCount += 1;
    stu.layer2FiredAt = now;
    if (stu.nudgeCount >= MAX_NUDGES_PER_STUDENT) stu.maxNudgesReached = true;

    state.firedPrompts.push({ type: conditionType, target: studentName, prompt: nudgeText, timestamp: now, layer: 2 });

    console.log(`[Nudge L2] ${conditionType} → ${studentName}: "${nudgeText.slice(0, 60)}..."`);

    sendToParticipant(sessionId, studentName, 'AI_PROMPT', {
      target: studentName, prompt: nudgeText, type: conditionType,
    });

    broadcastToAdmins(sessionId, 'INTERVENTION_FIRED', {
      target: studentName, type: conditionType, prompt: nudgeText,
      layer: 2, timestamp: new Date().toISOString(),
    });

    try {
      await supabase.from('prompts_log').insert({
        session_id: sessionId, target: studentName,
        prompt_text: nudgeText, prompt_type: conditionType, issued_by: 'ai_layer2',
      });
    } catch (e) {}

  } catch (err) {
    console.error('[Nudge L2] Claude error:', err.message);
  }
}

// ─── Main analysis loop ───────────────────────────────────────────────────────
// Runs every 30s. Two separate systems: prompt scheduler (pure logic) + nudge engine (condition-gated).
async function runAnalysis(sessionId) {
  try {
    checkPromptScheduler(sessionId);
  } catch (e) {
    console.error('[Prompt Scheduler] Error:', e.message);
  }
  try {
    await checkNudgeEngine(sessionId);
  } catch (e) {
    console.error('[Nudge Engine] Error:', e.message);
  }
}

// ─── Deepgram connection management ──────────────────────────────────────────

async function ensureConnection(sessionId, participantName) {
  const key = getConnectionKey(sessionId, participantName);
  if (activeConnections.has(key)) return activeConnections.get(key);

  console.log(`[Deepgram] Opening connection for ${participantName} in session ${sessionId}`);

  const connData = { connection: null, buffer: [], isOpen: false, keepAliveInterval: null };
  activeConnections.set(key, connData);

  const state = getSessionState(sessionId);
  if (!state.topic) {
    try {
      const { data } = await supabase.from('sessions').select('topic, session_config').eq('id', sessionId).single();
      state.topic = data?.topic || '';
      state.sessionConfig = data?.session_config || {};
      if (!state.openingQuestion) {
        state.openingQuestion = data?.session_config?.opening_question || null;
      }
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

    // Start analysis loop on first connection
    const allKeys = [...activeConnections.keys()].filter(k => k.startsWith(sessionId + '::'));
    if (allKeys.length === 1) {
      const s = getSessionState(sessionId);
      s.analysisInterval = setInterval(() => {
        runAnalysis(sessionId);
      }, 30000);
      console.log(`[Analysis] Loop started for session ${sessionId}`);
    }
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
      session_id: sessionId, speaker_name: participantName,
      utterance, timestamp_seconds: 0,
    });

    const state = getSessionState(sessionId);
    if (!state.participantStats[participantName]) {
      state.participantStats[participantName] = { talkTimeSeconds: 0, utteranceCount: 0 };
    }
    state.participantStats[participantName].utteranceCount += 1;
    state.participantStats[participantName].talkTimeSeconds += utterance.split(' ').length * 0.4;

    state.recentTranscript.push({ speaker: participantName, text: utterance, timestamp: Date.now() });
    if (state.recentTranscript.length > 40) state.recentTranscript.shift();

    // Update per-student last spoke time
    const stu = getStudentState(state, participantName);
    stu.lastSpokeAt = Date.now();

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
  });

  return connData;
}

async function scoreAndBroadcast(sessionId, state, speakerTag, batch) {
  try {
    const { scoreUtterance } = require('./scoring');
    const { broadcastToAdmins } = require('./websocket');
    const scoreResult = await scoreUtterance(sessionId, speakerTag, batch, state.topic, state.sessionConfig);
    if (!scoreResult) return;

    // Update per-student score tracking for nudge conditions
    const stu = getStudentState(state, speakerTag);
    const overallScore = scoreResult.scores?.overall_score;
    const topicScore = scoreResult.scores?.topic_adherence;

    if (overallScore != null) {
      stu.recentBatchScores.push(overallScore);
      if (stu.recentBatchScores.length > 3) stu.recentBatchScores.shift();
      // Track shallow batches: REMEMBER or UNDERSTAND Bloom, or low overall score
      const isShallow = ['REMEMBER', 'UNDERSTAND'].includes(scoreResult.bloom_level) || overallScore < 4;
      stu.consecutiveShallowBatches = isShallow ? stu.consecutiveShallowBatches + 1 : 0;
    }

    if (topicScore != null) {
      stu.recentTopicScores.push(topicScore);
      if (stu.recentTopicScores.length > 3) stu.recentTopicScores.shift();
    }

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
  const state = sessionState.get(sessionId);
  if (state?.analysisInterval) { clearInterval(state.analysisInterval); state.analysisInterval = null; }

  const keysToClose = [...activeConnections.keys()].filter(k => k.startsWith(sessionId + '::'));
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
  if (sessionConfig) {
    state.sessionConfig = sessionConfig;
    state.openingQuestion = sessionConfig.opening_question || null;
  }
  state.sessionStartedAt = Date.now();
  // Analysis loop starts when first participant connects (ensureConnection)
}

function getSessionStats(sessionId) {
  return sessionState.get(sessionId)?.participantStats || {};
}

function getInterventionLog(sessionId) {
  return sessionState.get(sessionId)?.firedPrompts || [];
}

// Called by websocket.js when a late-joining participant connects
function getSessionInfo(sessionId) {
  const state = sessionState.get(sessionId);
  if (!state || !state.sessionStartedAt) return null;
  return {
    openingQuestion: state.openingQuestion,
    topic: state.topic,
  };
}

module.exports = {
  sendAudioChunk, startTranscription, stopTranscription,
  getSessionStats, getInterventionLog, getSessionInfo,
};
