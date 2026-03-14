const Anthropic = require('@anthropic-ai/sdk');
const { retrieveRelevantChunks } = require('./rag');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Per-utterance scoring ────────────────────────────────────────────────────
// sessionConfig is optional — passed from transcription.js session cache
// If sessionConfig.objective_scoring_enabled and sessionConfig.objectives exist,
// Claude also scores against each learning objective (slower but richer)

async function scoreUtterance(sessionId, speakerTag, utterance, topic, sessionConfig = {}) {
  if (!utterance || utterance.trim().length === 0) return null;

  let relevantChunks = [];
  try {
    relevantChunks = await retrieveRelevantChunks(sessionId, utterance.trim(), 5);
  } catch (err) {
    console.error('[Scoring] RAG failed:', err.message);
  }

  const materialContext = relevantChunks.length > 0
    ? `Relevant course material:\n${relevantChunks.map((c, i) => `[${i+1}] ${c}`).join('\n\n')}`
    : 'No course materials uploaded for this session.';

  // Objective-aware scoring — only if professor enabled it and objectives exist
  const objectives = sessionConfig?.objective_scoring_enabled
    ? (sessionConfig?.objectives || [])
    : [];
  const hasObjectives = objectives.length > 0;

  const objectivesBlock = hasObjectives
    ? `\nLearning objectives for this session:\n${objectives.map((o, i) => `${i+1}. ${o}`).join('\n')}\n`
    : '';

  const objectiveScoreInstruction = hasObjectives
    ? `\nobjective_scores: an object mapping each objective (by its number, e.g. "1", "2") to a score 0-10 indicating how well this utterance addressed it. Use null if not addressed at all.`
    : '';

  const objectiveScoreJson = hasObjectives
    ? `,"objective_scores":{${objectives.map((_, i) => `"${i+1}":<0-10 or null>`).join(',')}}`
    : '';

  const prompt = `You are an academic discussion evaluator using Bloom's Taxonomy.

Session topic: ${topic || 'General academic discussion'}
Speaker: ${speakerTag}
${objectivesBlock}
${materialContext}

Utterance to score:
"${utterance.trim()}"

Score dimensions (0-10 each):
- topic_adherence: How relevant to the session topic
- depth: Analytical depth and critical thinking
- material_application: ${relevantChunks.length > 0 ? 'How well course material is applied' : 'General quality of academic reasoning'}
- overall_score: Holistic contribution quality
${objectiveScoreInstruction}

Highest Bloom level demonstrated: REMEMBER, UNDERSTAND, APPLY, ANALYSE, EVALUATE, or CREATE

Respond ONLY with valid JSON, no markdown:
{"scores":{"topic_adherence":<0-10>,"depth":<0-10>,"material_application":<0-10>,"overall_score":<0-10>},"bloom_level":"<LEVEL>","reasoning":"<one sentence>"${objectiveScoreJson}}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: hasObjectives ? 500 : 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content?.[0]?.text?.trim();
    if (!text) return null;

    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (!parsed?.scores || typeof parsed.scores.overall_score !== 'number') return null;

    if (hasObjectives) {
      console.log(`[Scoring] ${speakerTag}: overall=${parsed.scores.overall_score} bloom=${parsed.bloom_level} objectives=${JSON.stringify(parsed.objective_scores)}`);
    } else {
      console.log(`[Scoring] ${speakerTag}: overall=${parsed.scores.overall_score} bloom=${parsed.bloom_level}`);
    }
    return parsed;

  } catch (err) {
    console.error('[Scoring] Error:', err.message);
    return null;
  }
}

// ─── Group state analysis ─────────────────────────────────────────────────────
// Uses sessionConfig.interventions to respect professor-configured nudge prompts

async function analyseGroupState({ sessionId, topic, participantStats, recentTranscript, sessionConfig = {} }) {
  if (!participantStats || Object.keys(participantStats).length === 0) {
    return { intervention_needed: false };
  }

  const statsText = Object.entries(participantStats)
    .map(([name, s]) => `${name}: ${s.utteranceCount} utterances, ${Math.round(s.talkTimeSeconds)}s`)
    .join('\n');

  // Pull configured intervention prompts so Claude knows what text to use
  const interventions = sessionConfig?.interventions || {};
  const interventionContext = Object.keys(interventions).length > 0
    ? `\nConfigured intervention prompts (use these exact texts if applicable):\n${
        Object.entries(interventions)
          .filter(([, cfg]) => cfg.enabled)
          .map(([key, cfg]) => `- ${key}: "${cfg.prompt}"`)
          .join('\n')
      }`
    : '';

  const prompt = `You are a discussion facilitator AI.
Topic: ${topic || 'General academic discussion'}
${interventionContext}

Participation:
${statsText}

Recent transcript:
${recentTranscript || '(none)'}

Should you intervene? Respond ONLY with valid JSON, no markdown:
{"intervention_needed":<true|false>,"type":"<SILENT|DOMINATING|OFF_TOPIC|SHALLOW|null>","target":"<name or group>","prompt":"<prompt text or null>","reasoning":"<one sentence>"}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content?.[0]?.text?.trim();
    if (!text) return { intervention_needed: false };

    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);

  } catch (err) {
    console.error('[Group Analysis] Error:', err.message);
    return { intervention_needed: false };
  }
}

// ─── Post-session report ──────────────────────────────────────────────────────
// sessionConfig passed through from sessions.js /end endpoint

async function generatePostSessionReport({ sessionId, topic, transcripts, scores, materials, sessionConfig = {} }) {
  const transcriptText = (transcripts || [])
    .map(t => `${t.speaker_name}: ${t.utterance}`)
    .join('\n');

  const scoresSummary = Object.entries(scores || {})
    .map(([name, s]) => `${name}: overall=${s.overall ?? 'n/a'}, depth=${s.depth ?? 'n/a'}, topic_adherence=${s.topic_adherence ?? 'n/a'}, bloom=${s.bloom_level || 'unknown'}`)
    .join('\n');

  const participantNames = Object.keys(scores || {});
  const hasMaterials = (materials || []).length > 0;

  // Include learning objectives in report prompt if defined
  const objectives = sessionConfig?.objectives || [];
  const objectivesBlock = objectives.length > 0
    ? `\nLearning objectives:\n${objectives.map((o, i) => `${i+1}. ${o}`).join('\n')}\n`
    : '';

  const flagThreshold = sessionConfig?.flag_threshold ?? 4;

  if (transcriptText.trim().length === 0 && participantNames.length === 0) {
    return {
      executive_summary: 'No discussion data was recorded for this session.',
      group_performance: {
        strengths: [],
        gaps: ['No transcription data available'],
        bloom_summary: 'No data',
        material_coverage: hasMaterials ? 'Materials were uploaded but no discussion was recorded.' : 'No materials uploaded.',
        objective_achievement: objectives.length > 0 ? 'No data — session did not produce transcripts.' : null,
      },
      individual_insights: {},
      missed_concepts: [],
      facilitator_notes: 'Session ended without recorded discussion. Check that microphone permissions were granted on participant devices.',
      flagged_for_review: [],
    };
  }

  const prompt = `You are an academic discussion analyst generating a post-session report.

Session topic: ${topic || 'General academic discussion'}
Participants: ${participantNames.join(', ') || 'Unknown'}
Materials uploaded: ${hasMaterials ? 'Yes' : 'No'}
${objectivesBlock}
Scores summary:
${scoresSummary || 'No scores recorded'}

Full transcript:
${transcriptText || '(no transcript)'}

Generate a comprehensive post-session report. For each participant, provide four distinct fields:
- contribution_quality: A 1-2 sentence overall assessment of their discussion performance
- highlight: The single strongest thing they did — specific, grounded in what they actually said
- gap: The most important area they need to develop — honest and specific, not generic
- recommendation: One concrete, actionable thing they should do differently next time

Also flag any participant with an overall score of ${flagThreshold} or below in the flagged_for_review array.
${objectives.length > 0 ? 'Also assess which learning objectives were achieved, partially achieved, or missed by the group.' : ''}

Respond ONLY with valid JSON, no markdown:
{
  "executive_summary": "<2-3 sentence overview of discussion quality>",
  "group_performance": {
    "strengths": ["<strength 1>", "<strength 2>"],
    "gaps": ["<gap 1>", "<gap 2>"],
    "bloom_summary": "<summary of Bloom levels demonstrated across the group>",
    "material_coverage": "<how well the discussion engaged with course materials>",
    "objective_achievement": ${objectives.length > 0 ? '"<which objectives were achieved, partially achieved, or missed>"' : 'null'}
  },
  "individual_insights": {
    "<participant name>": {
      "contribution_quality": "<1-2 sentence overall assessment>",
      "highlight": "<their single strongest contribution or behaviour>",
      "gap": "<their most important area to develop>",
      "bloom_level": "<highest Bloom level they reached: REMEMBER|UNDERSTAND|APPLY|ANALYSE|EVALUATE|CREATE>",
      "recommendation": "<one concrete actionable thing to do differently next time>"
    }
  },
  "missed_concepts": ["<concept 1>", "<concept 2>"],
  "facilitator_notes": "<notes for the facilitator on how to follow up>",
  "flagged_for_review": ["<participant name if score <= ${flagThreshold}>"]
}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content?.[0]?.text?.trim();
    if (!text) throw new Error('Empty response from Claude');

    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    console.log(`[Report] Generated for session ${sessionId} with ${participantNames.length} participants`);
    return parsed;

  } catch (err) {
    console.error('[Report] Generation error:', err.message);
    return {
      executive_summary: 'Report generation encountered an error. Raw session data has been saved.',
      group_performance: {
        strengths: [],
        gaps: ['Report generation failed — please review transcript manually'],
        bloom_summary: scoresSummary || 'No score data',
        material_coverage: 'Unable to assess',
        objective_achievement: null,
      },
      individual_insights: Object.fromEntries(
        participantNames.map(name => [name, {
          contribution_quality: scores[name] ? `Overall score: ${scores[name].overall}` : 'No data',
          highlight: 'Unable to assess — please review transcript manually',
          gap: 'Unable to assess — please review transcript manually',
          bloom_level: scores[name]?.bloom_level || 'Unknown',
          recommendation: 'Review transcript manually',
        }])
      ),
      missed_concepts: [],
      facilitator_notes: `Error: ${err.message}`,
      flagged_for_review: [],
    };
  }
}

module.exports = { scoreUtterance, analyseGroupState, generatePostSessionReport };
