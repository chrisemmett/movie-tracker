const express = require('express');
const { getPool } = require('../db');
const omdb = require('../omdb');
const { upload, removeImage, downloadImage } = require('../upload');

const router = express.Router();

const FORMATS = ['bluray', 'uhd'];
// OMDB title-search types we expose to the client.
const SEARCH_TYPES = ['movie', 'series'];

function genCode(format, n) {
  return (format === 'uhd' ? 'UHD' : 'BD') + ' ' + String(n).padStart(3, '0');
}

function parseRatings(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Map a DB row to the disc shape the frontend expects.
function toDisc(row) {
  const poster = row.image_file ? `/uploads/${row.image_file}` : (row.poster_url || '');
  return {
    id: String(row.id),
    code: row.code || genCode(row.format, row.id),
    addedAt: row.created_at ? new Date(row.created_at).getTime() : 0,
    title: row.title || '',
    sortTitle: row.sort_title || '',
    year: row.year || '',
    format: FORMATS.includes(row.format) ? row.format : 'bluray',
    studio: row.studio || '',
    distributor: row.distributor || '',
    ripped: !!row.ripped,
    poster,
    hasUpload: !!row.image_file,
    director: row.director || '',
    cast: row.actors || '',
    plot: row.plot || '',
    genre: row.genre || '',
    runtime: row.runtime || '',
    rated: row.rated || '',
    ratings: parseRatings(row.ratings),
    imdbID: row.imdb_id || '',
  };
}

// Build the column map written on create/update from a multipart body.
function bodyToColumns(b) {
  const format = FORMATS.includes(b.format) ? b.format : 'bluray';
  return {
    title: (b.title || '').trim(),
    sort_title: (b.sortTitle || '').trim() || null,
    year: (b.year || '').trim() || null,
    format,
    studio: (b.studio || '').trim() || null,
    distributor: (b.distributor || '').trim() || null,
    ripped: b.ripped === 'true' || b.ripped === '1' || b.ripped === true ? 1 : 0,
    director: (b.director || '').trim() || null,
    actors: (b.cast || '').trim() || null,
    plot: (b.plot || '').trim() || null,
    genre: (b.genre || '').trim() || null,
    runtime: (b.runtime || '').trim() || null,
    rated: (b.rated || '').trim() || null,
    imdb_id: (b.imdbID || '').trim() || null,
    poster_url: (b.poster || '').trim() || null,
    ratings: JSON.stringify(parseRatings(b.ratings)),
  };
}

// ---- OMDB lookup endpoints (proxied so the API key stays server-side) ----

router.get('/api/omdb/search', async (req, res) => {
  try {
    const type = SEARCH_TYPES.includes(req.query.type) ? req.query.type : 'movie';
    res.json({ results: await omdb.search(req.query.q || '', { type }) });
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

// ---- Discs collection ----

router.get('/api/discs', async (req, res, next) => {
  try {
    const [rows] = await getPool().query('SELECT * FROM movies ORDER BY created_at DESC, id DESC');
    res.json({ discs: rows.map(toDisc) });
  } catch (err) {
    next(err);
  }
});

router.get('/api/discs/:id', async (req, res, next) => {
  try {
    const [rows] = await getPool().query('SELECT * FROM movies WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(toDisc(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.post('/api/discs', upload.single('image'), async (req, res, next) => {
  try {
    const data = bodyToColumns(req.body);
    if (!data.title) {
      if (req.file) removeImage(req.file.filename);
      return res.status(400).json({ error: 'Title is required.' });
    }
    // An uploaded file wins; otherwise copy the OMDB poster locally so we're
    // not reliant on the external host.
    if (req.file) {
      data.image_file = req.file.filename;
    } else if (data.poster_url) {
      const local = await downloadImage(data.poster_url);
      if (local) data.image_file = local;
    }

    const [countRows] = await getPool().query('SELECT COUNT(*) AS n FROM movies');
    data.code = genCode(data.format, (countRows[0].n || 0) + 1);

    const cols = Object.keys(data);
    const [result] = await getPool().query(
      `INSERT INTO movies (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map((c) => data[c])
    );
    const [rows] = await getPool().query('SELECT * FROM movies WHERE id = ?', [result.insertId]);
    res.status(201).json(toDisc(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.put('/api/discs/:id', upload.single('image'), async (req, res, next) => {
  try {
    const [existingRows] = await getPool().query('SELECT * FROM movies WHERE id = ?', [req.params.id]);
    if (!existingRows.length) {
      if (req.file) removeImage(req.file.filename);
      return res.status(404).json({ error: 'Not found' });
    }
    const existing = existingRows[0];
    const data = bodyToColumns(req.body);
    if (!data.title) {
      if (req.file) removeImage(req.file.filename);
      return res.status(400).json({ error: 'Title is required.' });
    }
    // New upload replaces the cover; otherwise, if there's no local image yet,
    // copy the OMDB poster locally so old discs migrate off the external host.
    if (req.file) {
      data.image_file = req.file.filename;
    } else if (!existing.image_file && data.poster_url) {
      const local = await downloadImage(data.poster_url);
      if (local) data.image_file = local;
    }
    // Keep the original catalog code; only mint one if it was missing.
    data.code = existing.code || genCode(data.format, existing.id);

    const cols = Object.keys(data);
    await getPool().query(
      `UPDATE movies SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...cols.map((c) => data[c]), req.params.id]
    );

    if (req.file && existing.image_file) removeImage(existing.image_file);
    const [rows] = await getPool().query('SELECT * FROM movies WHERE id = ?', [req.params.id]);
    res.json(toDisc(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.patch('/api/discs/:id/ripped', async (req, res, next) => {
  try {
    const ripped = req.body && (req.body.ripped === true || req.body.ripped === 'true' || req.body.ripped === 1) ? 1 : 0;
    const [result] = await getPool().query('UPDATE movies SET ripped = ? WHERE id = ?', [ripped, req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    const [rows] = await getPool().query('SELECT * FROM movies WHERE id = ?', [req.params.id]);
    res.json(toDisc(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.delete('/api/discs/:id', async (req, res, next) => {
  try {
    const [rows] = await getPool().query('SELECT image_file FROM movies WHERE id = ?', [req.params.id]);
    await getPool().query('DELETE FROM movies WHERE id = ?', [req.params.id]);
    if (rows.length && rows[0].image_file) removeImage(rows[0].image_file);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
