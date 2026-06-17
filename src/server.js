require('dotenv').config();

const path = require('path');
const express = require('express');
const methodOverride = require('method-override');

const { initDb } = require('./db');
const { UPLOAD_DIR } = require('./upload');
const moviesRouter = require('./routes/movies');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));

// Static assets and uploaded cover images.
app.use('/public', express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/', moviesRouter);

// 404
app.use((req, res) => {
  res.status(404).render('error', { message: 'Page not found.' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).render('error', { message: err.message || 'Something went wrong.' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Movie tracker listening on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
