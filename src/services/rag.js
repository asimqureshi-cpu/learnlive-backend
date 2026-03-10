const { OpenAI } = require('openai');
const supabase = require('./supabase');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function embedText(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('embedText called with empty input');
  }
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.trim(),
  });
  return response.data[0].embedding;
}

async function storeChunks(sessionId, materialId, chunks) {
  for (const chunk of chunks) {
    if (!chunk.text || chunk.text.trim().length === 0) continue;
    try {
      const embedding = await embedText(chunk.text);
      await supabase.from('document_chunks').insert({
        session_id: sessionId,
        material_id: materialId,
        chunk_text: chunk.text,
        chunk_index: chunk.index,
        embedding_vector: JSON.stringify(embedding),
      });
    } catch (err) {
      console.error('[RAG] Store chunk error:', err.message);
    }
  }
}

async function retrieveRelevantChunks(sessionId, queryText, topK = 5) {
  // Always return [] rather than throwing — scoring must continue without materials
  if (!queryText || queryText.trim().length === 0) return [];

  try {
    // Check whether this session has any material chunks at all
    const { count } = await supabase
      .from('document_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId);

    if (!count || count === 0) return []; // No materials — skip silently

    const queryEmbedding = await embedText(queryText);

    // Try pgvector RPC first
    const { data: vectorResults, error: vectorError } = await supabase.rpc('match_chunks', {
      query_embedding: queryEmbedding,
      match_session_id: sessionId,
      match_count: topK,
    });

    if (!vectorError && vectorResults && vectorResults.length > 0) {
      return vectorResults.map(r => r.chunk_text);
    }

    // Fallback: cosine similarity in JS
    const { data: allChunks, error: fetchError } = await supabase
      .from('document_chunks')
      .select('chunk_text, embedding_vector')
      .eq('session_id', sessionId)
      .limit(200);

    if (fetchError || !allChunks || allChunks.length === 0) return [];

    const cosineSim = (a, b) => {
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; normA += a[i]*a[i]; normB += b[i]*b[i]; }
      return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
    };

    return allChunks
      .filter(c => c.embedding_vector)
      .map(c => {
        try {
          const emb = typeof c.embedding_vector === 'string' ? JSON.parse(c.embedding_vector) : c.embedding_vector;
          return { text: c.chunk_text, score: cosineSim(queryEmbedding, emb) };
        } catch { return { text: c.chunk_text, score: 0 }; }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(r => r.text);

  } catch (err) {
    console.error('[RAG] Retrieve error:', err.message);
    return []; // Never throw — always return empty array
  }
}

module.exports = { embedText, storeChunks, retrieveRelevantChunks };
