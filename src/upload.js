const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

// Where uploaded cover images live. In Docker this is a mounted volume on the
// NAS (see docker-compose.yml). Configurable via UPLOAD_DIR.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed'));
  },
});

function removeImage(filename) {
  if (!filename) return;
  fs.promises
    .unlink(path.join(UPLOAD_DIR, filename))
    .catch(() => {}); // best effort — don't fail the request on cleanup
}

module.exports = { upload, removeImage, UPLOAD_DIR };
