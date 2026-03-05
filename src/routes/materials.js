const express = require('express');
const router = express.Router();
const multer = require('multer');
const supabase = require('../services/supabase');
const { ingestDocument } = require('../services/rag');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Upload a PDF document for a session
router.post('/:sessionId/upload', upload.single('file'), async (req, res) => {
  try {
    const { sessionId } = req.params;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    if (file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Only PDF files are supported' });

    // Store file in Supabase Storage
    const filePath = `${sessionId}/${Date.now()}-${file.originalname}`;
    const { error: storageError } = await supabase.storage
      .from('session-materials')
      .upload(filePath, file.buffer, { contentType: 'application/pdf' });

    if (storageError) throw storageError;

    // Record in materials table
    const { data: material, error: dbError } = await supabase.from('materials').insert({
      session_id: sessionId,
      file_name: file.originalname,
      file_path: filePath,
    }).select().single();

    if (dbError) throw dbError;

    // Ingest document into RAG pipeline (async)
    res.json({ success: true, material, message: 'File uploaded, processing started' });

    // Process after response sent
    ingestDocument(sessionId, material.id, file.originalname, file.buffer)
      .then(result => console.log(`[Materials] Ingested ${file.originalname}:`, result))
      .catch(err => console.error(`[Materials] Ingest error for ${file.originalname}:`, err));

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List materials for a session
router.get('/:sessionId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('materials')
      .select('id, file_name, uploaded_at')
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
