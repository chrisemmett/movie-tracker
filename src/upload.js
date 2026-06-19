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

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed'));
  },
});

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

// Download a remote image (e.g. an OMDB poster) into the upload dir so the
// collection isn't dependent on the external host staying up. Returns the
// stored filename, or null if it can't be fetched/validated (best effort —
// callers fall back to the remote URL).
async function downloadImage(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED.has(mime)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    const ext = EXT_BY_MIME[mime] || '.jpg';
    const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    await fs.promises.writeFile(path.join(UPLOAD_DIR, name), buf);
    return name;
  } catch {
    return null;
  }
}

function removeImage(filename) {
  if (!filename) return;
  fs.promises
    .unlink(path.join(UPLOAD_DIR, filename))
    .catch(() => {}); // best effort — don't fail the request on cleanup
}

module.exports = { upload, removeImage, downloadImage, UPLOAD_DIR };
