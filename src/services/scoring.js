const Anthropic = require('@anthropic-ai/sdk');
const { retrieveRelevantChunks } = require('./rag');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Score a single utterance against topic + materials
async function scoreUtterance({ sessionId, topic, speakerName, utterance, conversationContext }) {
  try {
    // Retrieve relevant material chunks for this utterance
    const relevantChunks = await retrieveRelevantChunks(sessionId, utterance, 5);
    const materialContext = relevantChunks.length > 0
      ? relevantChunks.map(c => `[From: ${c.fileName}]\n${c.text}`).join('\n\n')
      : 'No relevant material found for this utterance.';

    const prompt = `You are an educational assessment AI. Analyse this spoken contribution from a group discussion.

SESSION TOPIC: ${topic}

RECENT CONVERSATION CONTEXT:
${conversationContext || 'Beginning of session.'}

SPEAKER: ${speakerName}
UTTERANCE: "${utterance}"

RELEVANT MATERIAL FROM UPLOADED DOCUMENTS:
${materialContext}

Score this utterance on three dimensions. Return ONLY valid JSON, no other text.

{
  "topic_adherence": <0-10, how relevant is this to the session topic>,
  "depth": <0-10, surface claim=1-3, structured argument=4-6, evidence-supported=7-10>,
  "material_application": <0-10, 0=ignores materials, 5=compatible with materials but not applied, 10=directly draws on and correctly applies materials>,
  "reasoning": "<one sentence explaining the scores>",
  "flag": "<null, or one of: OFF_TOPIC | SHALLOW | MISSED_MATERIAL | STRONG_CONTRIBUTION>",
  "suggested_prompt": "<null, or a facilitation prompt to issue to this speaker if a flag was raised>"
}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('[Scoring] Error scoring utterance:', err);
    return {
      topic_adherence: 5,
      depth: 5,
      material_application: 5,
      reasoning: 'Scoring unavailable',
      flag: null,
      suggested_prompt: null,
    };
  }
}

// Detect group-level issues: silence, drift, untouched material concepts
async function analyseGroupState({ sessionId, topic, participantStats, recentTranscript }) {
  try {
    const prompt = `You are facilitating a group learning discussion. Analyse the current state.

SESSION TOPIC: ${topic}

PARTICIPANT STATISTICS (talk time in seconds):
${JSON.stringify(participantStats, null, 2)}

LAST 10 EXCHANGES:
${recentTranscript}

Identify the most important single intervention needed right now, if any. Return ONLY valid JSON:

{
  "intervention_needed": <true or false>,
  "type": "<null, or one of: SILENT_PARTICIPANT | GROUP_DRIFT | REDISTRIBUTE_FLOOR | PROBE_DEPTH>",
  "target": "<participant name if individual, or 'group' if for everyone>",
  "prompt": "<the exact prompt to display on screen, written as a direct facilitation question>",
  "reasoning": "<one sentence>"
}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('[Scoring] Group analysis error:', err);
    return { intervention_needed: false };
  }
}

// Generate full post-session report
async function generatePostSessionReport({ sessionId, topic, transcripts, scores, materials }) {
  try {
    const participantSummary = Object.entries(scores).map(([name, s]) =>
      `${name}: participation=${s.participation}/10, topic_adherence=${s.topic_adherence}/10, depth=${s.depth}/10, material_application=${s.material_application}/10`
    ).join('\n');

    const transcriptSummary = transcripts.slice(-50).map(t =>
      `[${t.speaker_name}]: ${t.utterance}`
    ).join('\n');

    const prompt = `You are producing a post-session learning report for an educator.

SESSION TOPIC: ${topic}
UPLOADED MATERIALS: ${materials.map(m => m.file_name).join(', ')}

PARTICIPANT SCORES:
${participantSummary}

TRANSCRIPT EXCERPT (final 50 exchanges):
${transcriptSummary}

Write a structured post-session report. Return ONLY valid JSON:

{
  "executive_summary": "<2-3 sentences: did the group meet the learning objectives? What was the overall quality?>",
  "group_performance": {
    "strengths": ["<strength 1>", "<strength 2>"],
    "gaps": ["<gap 1>", "<gap 2>"],
    "material_coverage": "<which parts of the uploaded materials were well-engaged vs ignored>"
  },
  "individual_insights": {
    "<participant_name>": {
      "highlight": "<their strongest contribution>",
      "gap": "<what they missed or avoided>",
      "recommendation": "<one actionable follow-up>"
    }
  },
  "facilitator_notes": "<advice for the educator on how to follow up with this group>",
  "missed_concepts": ["<key concept from materials never raised>", "<another>"]
}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('[Scoring] Report generation error:', err);
    throw err;
  }
}

module.exports = { scoreUtterance, analyseGroupState, generatePostSessionReport };
