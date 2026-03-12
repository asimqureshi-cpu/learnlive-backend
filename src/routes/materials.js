const express = require('express');
const router = express.Router();
const multer = require('multer');
const supabase = require('../services/supabase');
const { ingestDocument } = require('../services/rag');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

async function extractDocumentMetadata(textSample, fileName, topic) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Extract metadata from this document. Return ONLY valid JSON, no preamble.

FILE NAME: ${fileName}
SESSION TOPIC: ${topic || 'unknown'}
DOCUMENT TEXT (first 2000 chars):
${textSample}

{
  "title": "<document title or filename if unclear>",
  "author": "<author name(s) or 'Unknown'>",
  "key_topics": ["<topic 1>", "<topic 2>", "<topic 3>"],
  "relevance": "<one sentence: how this document relates to the session topic>"
}`
      }]
    });
    const text = response.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (err) {
    console.error('[Materials] Metadata extraction error:', err.message);
    return { title: fileName, author: 'Unknown', key_topics: [], relevance: '' };
  }
}

// Upload a PDF document for a session
router.post('/:sessionId/upload', upload.single('file'), async (req, res) => {
  try {
    const { sessionId } = req.params;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    if (file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Only PDF files are supported' });

    const filePath = `${sessionId}/${Date.now()}-${file.originalname}`;
    const { error: storageError } = await supabase.storage
      .from('session-materials')
      .upload(filePath, file.buffer, { contentType: 'application/pdf' });
    if (storageError) throw storageError;

    const { data: material, error: dbError } = await supabase.from('materials').insert({
      session_id: sessionId,
      file_name: file.originalname,
      file_path: filePath,
      metadata: null,
    }).select().single();
    if (dbError) throw dbError;

    res.json({ success: true, material, message: 'File uploaded, processing started' });

    // Process after response — ingest + extract metadata in parallel
    const pdfParse = require('pdf-parse');
    pdfParse(file.buffer).then(async (parsed) => {
      const textSample = parsed.text.slice(0, 2000);

      const { data: session } = await supabase.from('sessions').select('topic').eq('id', sessionId).single();

      const [ingestResult, metadata] = await Promise.all([
        ingestDocument(sessionId, material.id, file.originalname, file.buffer),
        extractDocumentMetadata(textSample, file.originalname, session?.topic),
      ]);

      await supabase.from('materials').update({ metadata }).eq('id', material.id);
      console.log(`[Materials] Ingested ${file.originalname}:`, ingestResult);
      console.log(`[Materials] Metadata for ${file.originalname}:`, metadata);
    }).catch(err => console.error(`[Materials] Processing error:`, err));

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List materials for a session
router.get('/:sessionId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('materials')
      .select('id, file_name, uploaded_at, metadata')
      .eq('session_id', req.params.sessionId);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a material
router.delete('/:materialId', async (req, res) => {
  try {
    const { data: material } = await supabase
      .from('materials').select('*').eq('id', req.params.materialId).single();
    if (material?.file_path) {
      await supabase.storage.from('session-materials').remove([material.file_path]);
    }
    await supabase.from('document_chunks').delete().eq('material_id', req.params.materialId);
    await supabase.from('materials').delete().eq('id', req.params.materialId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
