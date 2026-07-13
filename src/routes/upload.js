const router = require('express').Router();
const multer = require('multer');
const db = require('../db');
const { required, roles } = require('../auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Format non supporté (images uniquement)'));
  }
});

// POST /api/upload/logo
router.post('/logo', required, roles('owner', 'admin'), upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier requis' });
  
  try {
    const b64 = req.file.buffer.toString('base64');
    const dataUri = `data:${req.file.mimetype};base64,${b64}`;
    
    // On met à jour toutes les entreprises du tenant (MVP : 1 seule entreprise)
    await db.query('UPDATE businesses SET logo_url = $1 WHERE tenant_id = $2', [dataUri, req.auth.tid]);
    
    res.json({ success: true, logo_url: dataUri });
  } catch (e) {
    console.error('[upload]', e);
    res.status(500).json({ error: 'Erreur lors du traitement de l\'image' });
  }
});

module.exports = router;
