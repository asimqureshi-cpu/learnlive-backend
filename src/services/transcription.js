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
const INTERVENTION_COOLDOWN_MS = 60000; // 60s between any targeted intervention

function getSessionState(sessionId) {
  if (!sessionState.has(sessionId)) {
    sessionState.set(sessionId, {
      topic: null,
      sessionConfig: {},
      participantStats: {},
      recentTranscript: [],       // last 30 utterances with full text
      utteranceBuffer: {},
      firedInterventions: [],     // { type, target, prompt, timestamp, context }
      lastInterventionAt: 0,      // timestamp of last targeted intervention
      promptSchedulerInterval: null,
      scheduledPromptsQueue: [],  // professor prompts queued to fire at intervals
      nextScheduledPromptIndex: 0,
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
      if (currentSNR >= prev.snr) {
        prev.superseded = true;
        return false;
      } else {
        return true;
      }
    }
  }
  fresh.push({ text: utterance, participantName, timestamp: now, snr: currentSNR });
  return false;
}

// ─── Context-aware intervention analysis ─────────────────────────────────────
// Reads actual conversation content + material context.
// Only fires targeted prompts to individuals.
// Respects 60s cooldown.
async function analyseAndIntervene(sessionId) {
  const state = getSessionState(sessionId);
  if (!state || Object.keys(state.participantStats).length === 0) return;

  const now = Date.now();

  // Enforce cooldown — don't even call Claude if too soon
  if (now - state.lastInterventionAt < INTERVENTION_COOLDOWN_MS) return;

  // Need at least a few utterances before we can meaningfully analyse
  if (state.recentTranscript.length < 3) return;

  const { broadcastToSession, sendToParticipant, broadcastToAdmins } = require('./websocket');

  // Pull material context relevant to recent conversation
  const recentText = state.recentTranscript.slice(-10).map(u => u.text).join(' ');
  let materialContext = '';
  try {
    const chunks = await retrieveRelevantChunks(sessionId, recentText, 4);
    if (chunks.length > 0) {
      materialContext = `Relevant course material:\n${chunks.map((c, i) => `[${i+1}] ${c}`).join('\n\n')}`;
    }
  } catch (e) {}

  const objectives = state.sessionConfig?.objectives || [];
  const interventionRules = state.sessionConfig?.interventions || {};

  // Build participation summary
  const participantList = Object.entries(state.participantStats)
    .map(([name, s]) => `${name}: ${s.utteranceCount} contributions, ~${Math.round(s.talkTimeSeconds)}s`)
    .join('\n');

  // Last 15 utterances with speaker attribution
  const transcriptWindow = state.recentTranscript.slice(-15)
    .map(u => `[${u.speaker}]: ${u.text}`)
    .join('\n');

  // What interventions have already been fired (so Claude doesn't repeat)
  const firedSummary = state.firedInterventions.slice(-5)
    .map(f => `${f.target}: "${f.prompt}" (${Math.round((now - f.timestamp) / 1000)}s ago)`)
    .join('\n');

  // Which intervention types are enabled by professor
  const enabledTypes = Object.entries(interventionRules)
    .filter(([, cfg]) => cfg?.enabled)
    .map(([key, cfg]) => `${key}: "${cfg.prompt}"`)
    .join('\n');

  const prompt = `You are an AI discussion facilitator monitoring a live university seminar.

Session topic: ${state.topic || 'General academic discussion'}
${objectives.length > 0 ? `\nLearning objectives:\n${objectives.map((o, i) => `${i+1}. ${o}`).join('\n')}` : ''}

${materialContext ? materialContext + '\n' : ''}
Current participation:
${participantList}

Recent conversation (last 15 utterances):
${transcriptWindow}

${firedSummary ? `Recent interventions already fired (do not repeat these):\n${firedSummary}\n` : ''}
${enabledTypes ? `Professor-configured intervention prompts available:\n${enabledTypes}\n` : ''}

Analyse the discussion quality carefully. Consider:
1. Is any participant genuinely silent or disengaged (not just waiting their turn)?
2. Is the discussion actually shallow — are students just agreeing or summarising rather than analysing?
3. Is the discussion drifting from the learning objectives?
4. Is one person dominating in a way that's shutting others out?

IMPORTANT RULES:
- Only intervene if there is a CLEAR and SPECIFIC problem that warrants it
- If the discussion is flowing well, do NOT intervene — return intervention_needed: false
- Target interventions at a SPECIFIC individual, never "group" (group prompts are handled separately)
- Use the professor's configured prompt text if available for the relevant type, otherwise craft one
- The prompt should feel natural and contextually relevant to what was JUST said — reference the actual conversation
- Do not repeat a recent intervention

Respond ONLY with valid JSON, no markdown:
{"intervention_needed":false}
OR
{"intervention_needed":true,"type":"<SILENT|DOMINATING|OFF_TOPIC|SHALLOW>","target":"<exact participant name>","prompt":"<contextually relevant prompt text>","reasoning":"<one sentence why this is needed now>"}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content?.[0]?.text?.trim();
    if (!text) return;

    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    if (!result.intervention_needed || !result.target || !result.prompt) return;

    // Double-check cooldown (in case of concurrent calls)
    if (Date.now() - state.lastInterventionAt < INTERVENTION_COOLDOWN_MS) return;

    state.lastInterventionAt = Date.now();

    // Record this intervention
    state.firedInterventions.push({
      type: result.type,
      target: result.target,
      prompt: result.prompt,
      timestamp: Date.now(),
      reasoning: result.reasoning,
    });

    // Keep only last 10 interventions in memory
    if (state.firedInterventions.length > 10) state.firedInterventions.shift();

    console.log(`[Intervention] ${result.type} → ${result.target}: "${result.prompt.slice(0, 60)}..."`);

    // Send targeted prompt to individual student only
    sendToParticipant(sessionId, result.target, 'AI_PROMPT', {
      target: result.target,
      prompt: result.prompt,
      type: result.type,
    });

    // Log to admin dashboard (so professor can see what was sent and why)
    broadcastToAdmins(sessionId, 'INTERVENTION_FIRED', {
      target: result.target,
      type: result.type,
      prompt: result.prompt,
      reasoning: result.reasoning,
      timestamp: new Date().toISOString(),
    });

    // Log to prompts_log for report inclusion
    try {
      await supabase.from('prompts_log').insert({
        session_id: sessionId,
        target: result.target,
        prompt_text: result.prompt,
        prompt_type: result.type,
        issued_by: 'ai_intervention',
      });
    } catch (e) {}

  } catch (err) {
    console.error('[Intervention] Analysis error:', err.message);
  }
}

// ─── Schedule professor prompts evenly across session ─────────────────────────
function scheduleGeneralPrompts(sessionId) {
  const state = getSessionState(sessionId);
  const config = state.sessionConfig || {};
  const prompts = (config.discussion_prompts || []).filter(p => p.trim());
  const durationMs = (config.duration_minutes || 60) * 60 * 1000;

  if (prompts.length === 0) return;

  // Space prompts evenly — reserve first 5 min and last 5 min
  const usableMs = durationMs - (10 * 60 * 1000);
  const intervalMs = Math.max(usableMs / prompts.length, 3 * 60 * 1000); // min 3min between prompts

  console.log(`[Schedule] ${prompts.length} prompts over ${config.duration_minutes}min, interval: ${Math.round(intervalMs/60000)}min`);

  state.scheduledPromptsQueue = prompts;
  state.nextScheduledPromptIndex = 0;

  // Fire first prompt after 5 minutes, then at intervals
  let delay = 5 * 60 * 1000;
  prompts.forEach((p, i) => {
    setTimeout(() => {
      const currentState = getSessionState(sessionId);
      if (!currentState || currentState.nextScheduledPromptIndex !== i) return;

      const { broadcastToSession, broadcastToAdmins } = require('./websocket');
      console.log(`[Schedule] Firing general prompt ${i+1}: "${p.slice(0, 50)}..."`);

      broadcastToSession(sessionId, 'GENERAL_PROMPT', {
        prompt: p,
        target: 'group',
        index: i + 1,
        total: prompts.length,
      });

      broadcastToAdmins(sessionId, 'GENERAL_PROMPT_FIRED', {
        prompt: p,
        index: i + 1,
        total: prompts.length,
        timestamp: new Date().toISOString(),
      });

      currentState.nextScheduledPromptIndex = i + 1;

      // Log to prompts_log
      supabase.from('prompts_log').insert({
        session_id: sessionId,
        target: 'group',
        prompt_text: p,
        prompt_type: 'scheduled_general',
        issued_by: 'system',
      }).catch(() => {});

    }, delay + (i * intervalMs));
  });
}

async function ensureConnection(sessionId, participantName) {
  const key = getConnectionKey(sessionId, participantName);
  if (activeConnections.has(key)) return activeConnections.get(key);

  console.log(`[Deepgram] Opening connection for ${participantName} in session ${sessionId}`);

  const connData = {
    connection: null, buffer: [], isOpen: false,
    keepAliveInterval: null, interventionInterval: null,
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

    // Start intervention analysis on first connection for this session
    const allKeys = [...activeConnections.keys()].filter(k => k.startsWith(sessionId + '::'));
    if (allKeys.length === 1) {
      // Run context-aware intervention check every 60 seconds
      connData.interventionInterval = setInterval(() => {
        analyseAndIntervene(sessionId).catch(err =>
          console.error('[Intervention] Error:', err.message)
        );
      }, 60000);
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
      utterance: utterance,
      timestamp_seconds: 0,
    });

    const state = getSessionState(sessionId);
    if (!state.participantStats[speakerTag]) {
      state.participantStats[speakerTag] = { talkTimeSeconds: 0, utteranceCount: 0 };
    }
    state.participantStats[speakerTag].utteranceCount += 1;
    state.participantStats[speakerTag].talkTimeSeconds += utterance.split(' ').length * 0.4;

    // Store full text in recent transcript for intervention analysis
    state.recentTranscript.push({ speaker: speakerTag, text: utterance, timestamp: Date.now() });
    if (state.recentTranscript.length > 30) state.recentTranscript.shift();

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
    if (connData.interventionInterval) clearInterval(connData.interventionInterval);
    activeConnections.delete(key);
  });

  return connData;
}

async function scoreAndBroadcast(sessionId, state, speakerTag, batch) {
  try {
    const { scoreUtterance } = require('./scoring');
    const { broadcastToAdmins } = require('./websocket');
    const scoreResult = await scoreUtterance(sessionId, speakerTag, batch, state.topic, state.sessionConfig);
    if (!scoreResult) {
      console.warn(`[Scoring] No result for ${speakerTag} — batch dropped`);
      return;
    }
    await updateParticipantScore(sessionId, speakerTag, scoreResult, state);
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

async function updateParticipantScore(sessionId, speakerTag, scoreResult, state) {
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
    if (connData.isOpen) { connData.connection.send(chunk); }
    else { connData.buffer.push(chunk); }
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
    if (connData.interventionInterval) clearInterval(connData.interventionInterval);
    try { connData.connection.finish(); } catch (e) {}
    activeConnections.delete(key);
  }

  recentUtterances.delete(sessionId);
  sessionState.delete(sessionId);
  console.log(`[Transcription] All connections closed for session ${sessionId}`);
}

// startTranscription: caches config and schedules general prompts
function startTranscription(sessionId, topic, sessionConfig) {
  console.log(`[Transcription] Session ${sessionId} ready`);
  const state = getSessionState(sessionId);
  if (topic) state.topic = topic;
  if (sessionConfig) {
    state.sessionConfig = sessionConfig;
    // Schedule professor's discussion prompts
    scheduleGeneralPrompts(sessionId);
  }
}

function getSessionStats(sessionId) {
  const state = sessionState.get(sessionId);
  if (!state) return {};
  return state.participantStats;
}

// Returns intervention log for report inclusion
function getInterventionLog(sessionId) {
  const state = sessionState.get(sessionId);
  if (!state) return [];
  return state.firedInterventions || [];
}

module.exports = { sendAudioChunk, startTranscription, stopTranscription, getSessionStats, getInterventionLog };
