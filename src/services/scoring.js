const Anthropic = require('@anthropic-ai/sdk');
const { retrieveRelevantChunks } = require('./rag');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function scoreUtterance(sessionId, speakerTag, utterance, topic) {
  if (!utterance || utterance.trim().length === 0) return null;

  // RAG: returns [] if no materials, never throws
  let relevantChunks = [];
  try {
    relevantChunks = await retrieveRelevantChunks(sessionId, utterance.trim(), 5);
  } catch (err) {
    console.error('[Scoring] RAG failed, scoring without material context:', err.message);
  }

  const materialContext = relevantChunks.length > 0
    ? `Relevant course material:\n${relevantChunks.map((c, i) => `[${i+1}] ${c}`).join('\n\n')}`
    : 'No course materials have been uploaded for this session.';

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
    if (!text) { console.error('[Scoring] Empty Claude response'); return null; }

    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // Validate before returning — prevent downstream crashes
    if (!parsed?.scores || typeof parsed.scores.overall_score !== 'number') {
      console.error('[Scoring] Bad response structure:', clean);
      return null;
    }

    console.log(`[Scoring] ${speakerTag}: overall=${parsed.scores.overall_score} bloom=${parsed.bloom_level}`);
    return parsed;

  } catch (err) {
    console.error('[Scoring] Claude error:', err.message);
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

module.exports = { scoreUtterance, analyseGroupState, generatePostSessionReport };
