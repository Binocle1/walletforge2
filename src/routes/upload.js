const router = require('express').Router();
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { required, roles } = require('../auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Format non supporté (images uniquement)'));
  }
});

// POST /api/upload/logo
router.post('/logo', required, roles('owner', 'admin'), upload.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier requis' });
  
  try {
    const filename = `logo_${req.auth.tid}_${Date.now()}.webp`;
    const filepath = path.join(__dirname, '../../public/uploads/logos', filename);
    
    // Process with Sharp: resize, compress, convert to webp
    await sharp(req.file.buffer)
      .resize({ width: 200, height: 200, fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .webp({ quality: 80 })
      .toFile(filepath);

    const publicUrl = `/uploads/logos/${filename}`;
    
    // On met à jour toutes les entreprises du tenant (MVP : 1 seule entreprise)
    await db.query('UPDATE businesses SET logo_url = $1 WHERE tenant_id = $2', [publicUrl, req.auth.tid]);
    
    res.json({ success: true, logo_url: publicUrl });
  } catch (e) {
    console.error('[upload]', e);
    res.status(500).json({ error: 'Erreur lors du traitement de l\'image' });
  }
});

module.exports = router;
