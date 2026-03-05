const OpenAI = require('openai');
const pdfParse = require('pdf-parse');
const supabase = require('./supabase');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CHUNK_SIZE = 800;   // characters per chunk
const CHUNK_OVERLAP = 150;

// Split text into overlapping chunks
function chunkText(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end).trim());
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks.filter(c => c.length > 50);
}

// Embed a single string
async function embedText(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
}

// Ingest a PDF buffer for a session — extract, chunk, embed, store
async function ingestDocument(sessionId, materialId, fileName, pdfBuffer) {
  try {
    // 1. Extract text from PDF
    const parsed = await pdfParse(pdfBuffer);
    const text = parsed.text.replace(/\s+/g, ' ').trim();

    // 2. Chunk
    const chunks = chunkText(text);
    console.log(`[RAG] ${fileName}: ${chunks.length} chunks from ${text.length} chars`);

    // 3. Embed each chunk and store in Supabase
    // We store embeddings as JSON arrays in a document_chunks table
    const rows = [];
    for (let i = 0; i < chunks.length; i++) {
      const embedding = await embedText(chunks[i]);
      rows.push({
        session_id: sessionId,
        material_id: materialId,
        file_name: fileName,
        chunk_index: i,
        chunk_text: chunks[i],
        embedding: JSON.stringify(embedding),
      });
      // Small delay to avoid rate limits
      if (i % 10 === 0) await new Promise(r => setTimeout(r, 200));
    }

    const { error } = await supabase.from('document_chunks').insert(rows);
    if (error) throw error;

    console.log(`[RAG] Stored ${rows.length} chunks for ${fileName}`);
    return { success: true, chunkCount: rows.length };
  } catch (err) {
    console.error('[RAG] Ingest error:', err);
    throw err;
  }
}

// Retrieve top-k chunks most relevant to a query
async function retrieveRelevantChunks(sessionId, query, topK = 5) {
  try {
    const queryEmbedding = await embedText(query);

    // Fetch all chunks for session (for MVP scale this is fine; replace with pgvector for scale)
    const { data: chunks, error } = await supabase
      .from('document_chunks')
      .select('chunk_text, file_name, chunk_index')
      .eq('session_id', sessionId);

    if (error || !chunks || chunks.length === 0) return [];

    // Cosine similarity
    function cosineSim(a, b) {
      const aArr = JSON.parse(a);
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < aArr.length; i++) {
        dot += aArr[i] * b[i];
        normA += aArr[i] * aArr[i];
        normB += b[i] * b[i];
      }
      return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    // Get scored chunks
    const { data: chunksWithEmbeddings } = await supabase
      .from('document_chunks')
      .select('chunk_text, file_name, chunk_index, embedding')
      .eq('session_id', sessionId);

    const scored = chunksWithEmbeddings.map(c => ({
      ...c,
      score: cosineSim(c.embedding, queryEmbedding),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(c => ({
      text: c.chunk_text,
      fileName: c.file_name,
      relevanceScore: c.score,
    }));
  } catch (err) {
    console.error('[RAG] Retrieve error:', err);
    return [];
  }
}

module.exports = { ingestDocument, retrieveRelevantChunks };
