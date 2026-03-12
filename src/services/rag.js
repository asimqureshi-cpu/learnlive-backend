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
  for (let i = 0; i < chunks.length; i++) {
    const text = typeof chunks[i] === 'string' ? chunks[i] : chunks[i].text;
    const index = typeof chunks[i] === 'string' ? i : (chunks[i].index ?? i);
    if (!text || text.trim().length === 0) continue;
    try {
      const embedding = await embedText(text);
      await supabase.from('document_chunks').insert({
        session_id: sessionId,
        material_id: materialId,
        chunk_text: text,
        chunk_index: index,
        embedding_vector: JSON.stringify(embedding),
      });
    } catch (err) {
      console.error('[RAG] Store chunk error:', err.message);
    }
  }
}

async function ingestDocument(sessionId, materialId, fileName, buffer) {
  const pdfParse = require('pdf-parse');
  const parsed = await pdfParse(buffer);
  const text = parsed.text;

  // Split into ~500 word chunks with 50 word overlap
  const words = text.split(/\s+/);
  const chunks = [];
  const chunkSize = 500;
  const overlap = 50;
  for (let i = 0; i < words.length; i += chunkSize - overlap) {
    const chunk = words.slice(i, i + chunkSize).join(' ');
    if (chunk.trim().length > 50) chunks.push(chunk);
  }

  console.log(`[RAG] Ingesting ${fileName}: ${chunks.length} chunks`);
  await storeChunks(sessionId, materialId, chunks);
  return { chunks: chunks.length };
}

async function retrieveRelevantChunks(sessionId, queryText, topK = 5) {
  if (!queryText || queryText.trim().length === 0) return [];

  try {
    const { count } = await supabase
      .from('document_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId);

    if (!count || count === 0) return [];

    const queryEmbedding = await embedText(queryText);

    const { data: vectorResults, error: vectorError } = await supabase.rpc('match_chunks', {
      query_embedding: queryEmbedding,
      match_session_id: sessionId,
      match_count: topK,
    });

    if (!vectorError && vectorResults && vectorResults.length > 0) {
      return vectorResults.map(r => r.chunk_text);
    }

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
    return [];
  }
}

module.exports = { embedText, storeChunks, retrieveRelevantChunks, ingestDocument };
