
const Anthropic = require('@anthropic-ai/sdk');
const { retrieveRelevantChunks } = require('./rag');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function scoreUtterance(sessionId, speakerTag, utterance, topic) {
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

  const prompt = `You are an academic discussion evaluator using Bloom's Taxonomy.

Session topic: ${topic || 'General academic discussion'}
Speaker: ${speakerTag}

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
{"scores":{"topic_adherence":<0-10>,"depth":<0-10>,"material_application":<0-10>,"overall_score":<0-10>},"bloom_level":"<LEVEL>","reasoning":"<one sentence>"}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content?.[0]?.text?.trim();
    if (!text) return null;

    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (!parsed?.scores || typeof parsed.scores.overall_score !== 'number') return null;

    console.log(`[Scoring] ${speakerTag}: overall=${parsed.scores.overall_score} bloom=${parsed.bloom_level}`);
    return parsed;

  } catch (err) {
    console.error('[Scoring] Error:', err.message);
    return null;
  }
}

async function analyseGroupState({ sessionId, topic, participantStats, recentTranscript }) {
  if (!participantStats || Object.keys(participantStats).length === 0) {
    return { intervention_needed: false };
  }

  const statsText = Object.entries(participantStats)
    .map(([name, s]) => `${name}: ${s.utteranceCount} utterances, ${Math.round(s.talkTimeSeconds)}s`)
    .join('\n');

  const prompt = `You are a discussion facilitator AI.
Topic: ${topic || 'General academic discussion'}

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

async function generatePostSessionReport({ sessionId, topic, transcripts, scores, materials }) {
  // Build transcript text grouped by speaker
  const transcriptText = (transcripts || [])
    .map(t => `${t.speaker_tag}: ${t.utterance_text}`)
    .join('\n');

  // Build scores summary
  const scoresSummary = Object.entries(scores || {})
    .map(([name, s]) => `${name}: overall=${s.overall ?? 'n/a'}, depth=${s.depth ?? 'n/a'}, topic_adherence=${s.topic_adherence ?? 'n/a'}, bloom=${s.bloom_level || 'unknown'}`)
    .join('\n');

  const participantNames = Object.keys(scores || {});
  const hasMaterials = (materials || []).length > 0;

  if (transcriptText.trim().length === 0 && participantNames.length === 0) {
    // Return a minimal valid report so the session can still be marked complete
    return {
      executive_summary: 'No discussion data was recorded for this session.',
      group_performance: {
        strengths: [],
        gaps: ['No transcription data available'],
        bloom_summary: 'No data',
        material_coverage: hasMaterials ? 'Materials were uploaded but no discussion was recorded.' : 'No materials uploaded.',
      },
      individual_insights: {},
      missed_concepts: [],
      facilitator_notes: 'Session ended without recorded discussion. Check that microphone permissions were granted on participant devices.',
    };
  }

  const prompt = `You are an academic discussion analyst generating a post-session report.

Session topic: ${topic || 'General academic discussion'}
Participants: ${participantNames.join(', ') || 'Unknown'}
Materials uploaded: ${hasMaterials ? 'Yes' : 'No'}

Scores summary:
${scoresSummary || 'No scores recorded'}

Full transcript:
${transcriptText || '(no transcript)'}

Generate a comprehensive post-session report. Respond ONLY with valid JSON, no markdown:
{
  "executive_summary": "<2-3 sentence overview of discussion quality>",
  "group_performance": {
    "strengths": ["<strength 1>", "<strength 2>"],
    "gaps": ["<gap 1>", "<gap 2>"],
    "bloom_summary": "<summary of Bloom levels demonstrated>",
    "material_coverage": "<how well the discussion engaged with course materials, or note if none uploaded>"
  },
  "individual_insights": {
    "<participant name>": {
      "contribution_quality": "<assessment>",
      "bloom_level": "<highest level reached>",
      "recommendation": "<specific actionable feedback>"
    }
  },
  "missed_concepts": ["<concept 1>", "<concept 2>"],
  "facilitator_notes": "<notes for the facilitator on how to follow up>"
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
    // Return a valid fallback so the 500 doesn't block session completion
    return {
      executive_summary: 'Report generation encountered an error. Raw session data has been saved.',
      group_performance: {
        strengths: [],
        gaps: ['Report generation failed — please review transcript manually'],
        bloom_summary: scoresSummary || 'No score data',
        material_coverage: 'Unable to assess',
      },
      individual_insights: Object.fromEntries(
        participantNames.map(name => [name, {
          contribution_quality: scores[name] ? `Overall score: ${scores[name].overall}` : 'No data',
          bloom_level: scores[name]?.bloom_level || 'Unknown',
          recommendation: 'Review transcript manually',
        }])
      ),
      missed_concepts: [],
      facilitator_notes: `Error: ${err.message}`,
    };
  }
}

module.exports = { scoreUtterance, analyseGroupState, generatePostSessionReport };
