const express = require('express');
const { getPool } = require('../db');
const omdb = require('../omdb');
const { upload, removeImage } = require('../upload');

const router = express.Router();

const FORMATS = ['Blu-ray', 'UHD'];

// Columns that can be written from form/OMDB data.
const ENRICH_FIELDS = [
  'imdb_id', 'year', 'rated', 'released', 'runtime', 'genre', 'director',
  'writer', 'actors', 'plot', 'language', 'country', 'poster_url', 'imdb_rating',
];

function pickEnrichment(body) {
  const out = {};
  for (const f of ENRICH_FIELDS) {
    out[f] = body[f] && String(body[f]).trim() !== '' ? body[f] : null;
  }
  out.omdb_raw = body.omdb_raw && String(body.omdb_raw).trim() !== '' ? body.omdb_raw : null;
  return out;
}

// ---- OMDB lookup endpoints (consumed by the add/edit page via fetch) ----

router.get('/api/omdb/search', async (req, res) => {
  try {
    const results = await omdb.search(req.query.q || '');
    res.json({ results });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/api/omdb/detail/:imdbID', async (req, res) => {
  try {
    res.json(await omdb.detail(req.params.imdbID));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- Collection list ----

router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const format = FORMATS.includes(req.query.format) ? req.query.format : '';

    const where = [];
    const params = [];
    if (q) {
      where.push('(title LIKE ? OR studio LIKE ? OR distributor LIKE ? OR director LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    if (format) {
      where.push('format = ?');
      params.push(format);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await getPool().query(
      `SELECT * FROM movies ${clause} ORDER BY title ASC`,
      params
    );
    res.render('index', { movies: rows, q, format, formats: FORMATS });
  } catch (err) {
    next(err);
  }
});

// ---- New ----

router.get('/movies/new', (req, res) => {
  res.render('form', { movie: {}, formats: FORMATS, action: '/movies', method: 'POST' });
});

router.post('/movies', upload.single('image'), async (req, res, next) => {
  try {
    const b = req.body;
    const data = {
      title: (b.title || '').trim(),
      studio: (b.studio || '').trim() || null,
      distributor: (b.distributor || '').trim() || null,
      format: FORMATS.includes(b.format) ? b.format : 'Blu-ray',
      image_file: req.file ? req.file.filename : null,
      ...pickEnrichment(b),
    };
    if (!data.title) {
      if (req.file) removeImage(req.file.filename);
      return res.status(400).render('error', { message: 'Title is required.' });
    }

    const cols = Object.keys(data);
    await getPool().query(
      `INSERT INTO movies (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map((c) => data[c])
    );
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

// ---- Detail ----

router.get('/movies/:id', async (req, res, next) => {
  try {
    const [rows] = await getPool().query('SELECT * FROM movies WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).render('error', { message: 'Title not found.' });
    res.render('show', { movie: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---- Edit ----

router.get('/movies/:id/edit', async (req, res, next) => {
  try {
    const [rows] = await getPool().query('SELECT * FROM movies WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).render('error', { message: 'Title not found.' });
    res.render('form', {
      movie: rows[0],
      formats: FORMATS,
      action: `/movies/${rows[0].id}?_method=PUT`,
      method: 'POST',
    });
  } catch (err) {
    next(err);
  }
});

router.put('/movies/:id', upload.single('image'), async (req, res, next) => {
  try {
    const [rows] = await getPool().query('SELECT * FROM movies WHERE id = ?', [req.params.id]);
    if (!rows.length) {
      if (req.file) removeImage(req.file.filename);
      return res.status(404).render('error', { message: 'Title not found.' });
    }
    const existing = rows[0];
    const b = req.body;

    const data = {
      title: (b.title || '').trim() || existing.title,
      studio: (b.studio || '').trim() || null,
      distributor: (b.distributor || '').trim() || null,
      format: FORMATS.includes(b.format) ? b.format : existing.format,
      ...pickEnrichment(b),
    };
    if (req.file) data.image_file = req.file.filename;

    const cols = Object.keys(data);
    await getPool().query(
      `UPDATE movies SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...cols.map((c) => data[c]), req.params.id]
    );

    // Swap out the old image only after the row is updated.
    if (req.file && existing.image_file) removeImage(existing.image_file);
    res.redirect(`/movies/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// ---- Delete ----

router.delete('/movies/:id', async (req, res, next) => {
  try {
    const [rows] = await getPool().query('SELECT image_file FROM movies WHERE id = ?', [req.params.id]);
    await getPool().query('DELETE FROM movies WHERE id = ?', [req.params.id]);
    if (rows.length && rows[0].image_file) removeImage(rows[0].image_file);
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
