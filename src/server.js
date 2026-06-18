require('dotenv').config();

const path = require('path');
const express = require('express');

const { initDb } = require('./db');
const { UPLOAD_DIR } = require('./upload');
const discsRouter = require('./routes/discs');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json());

// Uploaded cover images (stored on the NAS volume) and the static SPA.
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/', discsRouter);

// Unknown API routes return JSON; everything else falls back to the SPA shell.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Something went wrong.' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`STACKS listening on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
