const Anthropic = require('@anthropic-ai/sdk');
const { retrieveRelevantChunks } = require('./rag');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function scoreUtterance({ sessionId, topic, speakerName, utterance, conversationContext }) {
  try {
    const relevantChunks = await retrieveRelevantChunks(sessionId, utterance, 5);
    const materialContext = relevantChunks.length > 0
      ? relevantChunks.map(c => `[From: ${c.fileName}]\n${c.text}`).join('\n\n')
      : 'No relevant material found for this utterance.';

    const prompt = `You are an educational assessment AI scoring a spoken contribution in a group discussion.

SESSION TOPIC: ${topic}

CONVERSATION CONTEXT (recent exchanges):
${conversationContext || 'Start of session.'}

SPEAKER: ${speakerName}
CONTRIBUTION: "${utterance}"

RELEVANT MATERIAL FROM UPLOADED DOCUMENTS:
${materialContext}

SCORING RULES:

topic_adherence (0-10):
- 0 if completely off-topic
- 10 if directly and specifically addresses the session topic

depth (0-10) — use Bloom's Taxonomy levels as your guide:
- 1-2: REMEMBER — reciting facts, definitions, or memorised statements ("ethics means doing the right thing")
- 3-4: UNDERSTAND — explaining or paraphrasing concepts in own words, showing basic comprehension
- 5-6: APPLY — using a concept to explain a situation or example ("Kant's categorical imperative would say X in this case")
- 7-8: ANALYSE — breaking down arguments, comparing positions, identifying assumptions or contradictions
- 9-10: EVALUATE/CREATE — making and defending original judgements, synthesising multiple frameworks, critiquing with evidence

material_application (0-10):
- 0 if materialContext says "No relevant material found" OR utterance completely ignores the materials
- 3-4 if utterance is consistent with materials but does not explicitly reference them
- 6-7 if utterance clearly draws on concepts present in the retrieved material
- 9-10 if utterance directly quotes, names, or precisely applies specific frameworks from the materials

ADDITIONAL RULES:
- Do NOT award material_application > 5 if materialContext says "No relevant material found"
- Flag STRONG_CONTRIBUTION only if depth >= 7 AND material_application >= 6
- Flag SHALLOW if depth <= 3
- Flag MISSED_MATERIAL if material_application <= 2 AND relevant material WAS found
- Flag OFF_TOPIC if topic_adherence <= 3

bloom_level should reflect the highest Bloom level clearly demonstrated.

Return ONLY valid JSON, no preamble, no markdown:
{
  "topic_adherence": <0-10>,
  "depth": <0-10>,
  "material_application": <0-10>,
  "bloom_level": "<REMEMBER|UNDERSTAND|APPLY|ANALYSE|EVALUATE|CREATE>",
  "reasoning": "<one sentence explaining all scores>",
  "flag": <null or "OFF_TOPIC"|"SHALLOW"|"MISSED_MATERIAL"|"STRONG_CONTRIBUTION">,
  "suggested_prompt": <null or a direct facilitation question to push this speaker deeper>
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
      bloom_level: 'UNDERSTAND',
      reasoning: 'Scoring unavailable',
      flag: null,
      suggested_prompt: null,
    };
  }
}

async function analyseGroupState({ sessionId, topic, participantStats, recentTranscript }) {
  try {
    const prompt = `You are facilitating a group learning discussion. Analyse the current state.

SESSION TOPIC: ${topic}

PARTICIPANT STATISTICS (talk time in seconds):
${JSON.stringify(participantStats, null, 2)}

LAST 10 EXCHANGES:
${recentTranscript}

Identify the most important single intervention needed right now, if any.
Consider:
- Is any participant dominating or silent?
- Is the group stuck at a low Bloom level (just remembering/understanding) when they should be analysing or evaluating?
- Has the discussion drifted from the topic?
- Are materials being ignored?

Return ONLY valid JSON, no preamble:
{
  "intervention_needed": <true or false>,
  "type": "<null or SILENT_PARTICIPANT|GROUP_DRIFT|REDISTRIBUTE_FLOOR|PROBE_DEPTH|PUSH_BLOOM_LEVEL>",
  "target": "<participant name if individual, or 'group' if for everyone>",
  "prompt": "<the exact prompt to display on screen as a direct facilitation question>",
  "reasoning": "<one sentence>",
  "bloom_target": "<null or the Bloom level you are trying to push the group toward>"
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

async function generatePostSessionReport({ sessionId, topic, transcripts, scores, materials }) {
  try {
    const participantSummary = Object.entries(scores).map(([name, s]) =>
      `${name}: participation=${s.participation}/10, topic_adherence=${s.topic_adherence}/10, depth=${s.depth}/10, material_application=${s.material_application}/10, bloom_level=${s.bloom_level || 'unknown'}`
    ).join('\n');

    const transcriptSummary = transcripts.slice(-50).map(t =>
      `[${t.speaker_name}]: ${t.utterance}`
    ).join('\n');

    const prompt = `You are producing a post-session learning report for an educator.

SESSION TOPIC: ${topic}
UPLOADED MATERIALS: ${materials.map(m => m.file_name).join(', ')}

PARTICIPANT SCORES (including Bloom's Taxonomy level reached):
${participantSummary}

TRANSCRIPT EXCERPT (final 50 exchanges):
${transcriptSummary}

Write a structured post-session report. Be specific and evidence-based — reference actual things said in the transcript.
Do not write generic placeholder text. If data is thin, say so briefly and move on.

Return ONLY valid JSON, no preamble:
{
  "executive_summary": "<2-3 sentences: did the group meet learning objectives? Overall quality? Highest Bloom level reached?>",
  "group_performance": {
    "strengths": ["<specific strength with evidence from transcript>", "<another>"],
    "gaps": ["<specific gap with evidence>", "<another>"],
    "material_coverage": "<which parts of uploaded materials were well-engaged vs ignored>",
    "bloom_summary": "<what Bloom levels were demonstrated across the group and what level was missing>"
  },
  "individual_insights": {
    "<participant_name>": {
      "highlight": "<their strongest contribution with a brief quote or paraphrase>",
      "gap": "<what they missed, avoided, or stayed too shallow on>",
      "bloom_level_reached": "<highest Bloom level they demonstrated>",
      "recommendation": "<one specific actionable follow-up task for this participant>"
    }
  },
  "facilitator_notes": "<concrete advice for the educator: what to cover in next session, who needs support, what concepts need revisiting>",
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
