const Anthropic = require('@anthropic-ai/sdk');
const { retrieveRelevantChunks } = require('./rag');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Per-utterance scoring ────────────────────────────────────────────────────
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

  const objectives = sessionConfig?.objective_scoring_enabled
    ? (sessionConfig?.objectives || []) : [];
  const hasObjectives = objectives.length > 0;

  const objectivesBlock = hasObjectives
    ? `\nLearning objectives:\n${objectives.map((o, i) => `${i+1}. ${o}`).join('\n')}\n`
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

    console.log(`[Scoring] ${speakerTag}: overall=${parsed.scores.overall_score} bloom=${parsed.bloom_level} objectives=${JSON.stringify(parsed.objective_scores || null)}`);
    return parsed;

  } catch (err) {
    console.error('[Scoring] Error:', err.message);
    return null;
  }
}

// ─── Group state analysis with material context ───────────────────────────────
// Runs every 30s. Reads real transcript + pulls RAG chunks relevant to what
// was just discussed. Claude decides whether to intervene and generates the
// actual nudge text — never uses fixed strings.
async function analyseGroupState({ sessionId, topic, participantStats, recentTranscript, sessionConfig = {} }) {
  if (!participantStats || Object.keys(participantStats).length === 0) {
    return { intervention_needed: false };
  }

  // Pull material chunks relevant to the actual conversation
  let materialContext = '';
  try {
    const recentText = recentTranscript.split('\n').slice(-5).join(' ').replace(/\[.*?\]:\s*/g, '');
    if (recentText.trim().length > 10) {
      const chunks = await retrieveRelevantChunks(sessionId, recentText || topic, 3);
      if (chunks.length > 0) {
        materialContext = `\nRelevant course material students should be engaging with:\n${chunks.map((c, i) => `[${i+1}] ${c}`).join('\n\n')}\n`;
      }
    }
  } catch (e) {}

  const statsText = Object.entries(participantStats)
    .map(([name, s]) => `${name}: ${s.utteranceCount} utterances, ${Math.round(s.talkTimeSeconds)}s talk time`)
    .join('\n');

  const objectives = sessionConfig?.objectives || [];
  const objectivesBlock = objectives.length > 0
    ? `\nLearning objectives:\n${objectives.map((o, i) => `${i+1}. ${o}`).join('\n')}\n`
    : '';

  // Professor's configured intervention types (on/off only — Claude writes the actual text)
  const interventions = sessionConfig?.interventions || {};
  const enabledTypes = Object.entries(interventions)
    .filter(([, cfg]) => cfg?.enabled)
    .map(([key]) => key)
    .join(', ');

  const prompt = `You are an AI facilitator monitoring a live university seminar.

Session topic: ${topic || 'General academic discussion'}
${objectivesBlock}${materialContext}
Current participation:
${statsText}

Recent conversation:
${recentTranscript || '(none yet)'}

${enabledTypes ? `Professor has enabled these intervention types: ${enabledTypes}\n` : ''}

Analyse the discussion carefully. Decide if intervention is needed NOW based on:
1. SILENT: A participant has said very little relative to others — gently invite them in
2. DOMINATING: One participant is monopolising — redirect to others  
3. OFF_TOPIC: The discussion has drifted away from the session topic or objectives
4. SHALLOW: Participants are only recalling/summarising, not analysing, applying or evaluating

CRITICAL RULES:
- If there is only one participant, NEVER use DOMINATING
- Only intervene if there is a GENUINE, CLEAR problem right now
- If the discussion is going well, return intervention_needed: false
- The prompt you write MUST be specific to what was actually just said — reference it
- If materials are provided above, the prompt MUST reference a specific concept from those materials
- Write the prompt as a natural facilitator question, not a rebuke — warm but challenging
- Target a SPECIFIC participant name for SILENT/SHALLOW/OFF_TOPIC, or "group" for DOMINATING/group redirects

Respond ONLY with valid JSON, no markdown:
{"intervention_needed":false}
OR
{"intervention_needed":true,"type":"<SILENT|DOMINATING|OFF_TOPIC|SHALLOW>","target":"<exact participant name or group>","prompt":"<your contextual, material-grounded nudge>","reasoning":"<one sentence why>"}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content?.[0]?.text?.trim();
    if (!text) return { intervention_needed: false };

    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);
    if (result.intervention_needed) {
      console.log(`[Group Analysis] Intervention: ${result.type} → ${result.target} — ${result.reasoning}`);
    }
    return result;

  } catch (err) {
    console.error('[Group Analysis] Error:', err.message);
    return { intervention_needed: false };
  }
}

// ─── Post-session report ──────────────────────────────────────────────────────
async function generatePostSessionReport({ sessionId, topic, transcripts, scores, materials, sessionConfig = {} }) {
  const transcriptText = (transcripts || [])
    .map(t => `${t.speaker_name}: ${t.utterance}`)
    .join('\n');

  const scoresSummary = Object.entries(scores || {})
    .map(([name, s]) => `${name}: overall=${s.overall ?? 'n/a'}, depth=${s.depth ?? 'n/a'}, topic_adherence=${s.topic_adherence ?? 'n/a'}, bloom=${s.bloom_level || 'unknown'}`)
    .join('\n');

  const participantNames = Object.keys(scores || {});
  const hasMaterials = (materials || []).length > 0;
  const objectives = sessionConfig?.objectives || [];
  const objectivesBlock = objectives.length > 0
    ? `\nLearning objectives:\n${objectives.map((o, i) => `${i+1}. ${o}`).join('\n')}\n`
    : '';
  const flagThreshold = sessionConfig?.flag_threshold ?? 4;

  if (transcriptText.trim().length === 0 && participantNames.length === 0) {
    return {
      executive_summary: 'No discussion data was recorded for this session.',
      group_performance: {
        strengths: [], gaps: ['No transcription data available'],
        bloom_summary: 'No data',
        material_coverage: hasMaterials ? 'Materials uploaded but no discussion recorded.' : 'No materials uploaded.',
        objective_achievement: null,
      },
      individual_insights: {}, missed_concepts: [],
      facilitator_notes: 'Session ended without recorded discussion. Check microphone permissions.',
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

For each participant provide: contribution_quality (1-2 sentences), highlight (their strongest specific contribution), gap (most important area to develop — honest, not generic), bloom_level (highest reached), recommendation (one concrete actionable thing).

Flag participants with overall score ≤ ${flagThreshold} in flagged_for_review.
${objectives.length > 0 ? 'Assess which learning objectives were achieved, partially achieved, or missed.' : ''}

Respond ONLY with valid JSON, no markdown:
{
  "executive_summary": "<2-3 sentence overview>",
  "group_performance": {
    "strengths": ["<strength 1>", "<strength 2>"],
    "gaps": ["<gap 1>", "<gap 2>"],
    "bloom_summary": "<summary of Bloom levels>",
    "material_coverage": "<how well discussion engaged materials>",
    "objective_achievement": ${objectives.length > 0 ? '"<which objectives achieved/missed>"' : 'null'}
  },
  "individual_insights": {
    "<participant name>": {
      "contribution_quality": "<assessment>",
      "highlight": "<strongest contribution>",
      "gap": "<area to develop>",
      "bloom_level": "<REMEMBER|UNDERSTAND|APPLY|ANALYSE|EVALUATE|CREATE>",
      "recommendation": "<actionable feedback>"
    }
  },
  "missed_concepts": ["<concept 1>"],
  "facilitator_notes": "<follow-up notes>",
  "flagged_for_review": ["<name if score ≤ ${flagThreshold}>"]
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
      executive_summary: 'Report generation failed. Raw session data saved.',
      group_performance: {
        strengths: [], gaps: ['Report generation failed — review transcript manually'],
        bloom_summary: scoresSummary || 'No score data',
        material_coverage: 'Unable to assess', objective_achievement: null,
      },
      individual_insights: Object.fromEntries(
        participantNames.map(name => [name, {
          contribution_quality: scores[name] ? `Overall score: ${scores[name].overall}` : 'No data',
          highlight: 'Unable to assess', gap: 'Unable to assess',
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
