const mysql = require('mysql2/promise');

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'db',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'movietracker',
      password: process.env.DB_PASSWORD || 'movietracker',
      database: process.env.DB_NAME || 'movietracker',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: 'utf8mb4',
    });
  }
  return pool;
}

// Create the schema on startup. Simple and idempotent — fine for a
// single-user, personal collection tracker.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS movies (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  code          VARCHAR(32)  NULL,
  title         VARCHAR(255) NOT NULL,
  sort_title    VARCHAR(255) NULL,
  studio        VARCHAR(255) NULL,
  distributor   VARCHAR(255) NULL,
  format        VARCHAR(32)  NOT NULL DEFAULT 'bluray',
  ripped        TINYINT(1)   NOT NULL DEFAULT 0,
  image_file    VARCHAR(255) NULL,

  -- Enrichment pulled from OMDB and stored locally
  imdb_id       VARCHAR(20)  NULL,
  year          VARCHAR(16)  NULL,
  rated         VARCHAR(32)  NULL,
  released      VARCHAR(64)  NULL,
  runtime       VARCHAR(32)  NULL,
  genre         VARCHAR(255) NULL,
  director      VARCHAR(255) NULL,
  writer        TEXT         NULL,
  actors        TEXT         NULL,
  plot          TEXT         NULL,
  language      VARCHAR(255) NULL,
  country       VARCHAR(255) NULL,
  poster_url    TEXT         NULL,
  imdb_rating   VARCHAR(16)  NULL,
  ratings       JSON         NULL,
  omdb_raw      JSON         NULL,

  created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_title (title),
  INDEX idx_format (format),
  INDEX idx_created (created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

// Columns added after the original release. Ensures upgrades of an existing
// install pick up the new fields without a manual migration.
const ADDED_COLUMNS = [
  { name: 'code', ddl: "ADD COLUMN code VARCHAR(32) NULL AFTER id" },
  { name: 'ripped', ddl: "ADD COLUMN ripped TINYINT(1) NOT NULL DEFAULT 0 AFTER format" },
  { name: 'ratings', ddl: "ADD COLUMN ratings JSON NULL AFTER imdb_rating" },
  { name: 'sort_title', ddl: "ADD COLUMN sort_title VARCHAR(255) NULL AFTER title" },
  { name: 'formats', ddl: "ADD COLUMN formats JSON NULL AFTER format" },
];

// Indexes added after the original release. Like ADDED_COLUMNS, this lets an
// existing install pick up new indexes on boot without a manual migration.
// MySQL has no portable "CREATE INDEX IF NOT EXISTS", so we probe
// information_schema first.
const ADDED_INDEXES = [
  // Backs the list route's `ORDER BY created_at DESC, id DESC`, which is run on
  // every page load and returns the whole collection.
  { name: 'idx_created', ddl: 'ADD INDEX idx_created (created_at, id)' },
];

async function ensureIndexes(conn) {
  const dbName = process.env.DB_NAME || 'movietracker';
  for (const idx of ADDED_INDEXES) {
    const [rows] = await conn.query(
      `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = 'movies' AND index_name = ? LIMIT 1`,
      [dbName, idx.name]
    );
    if (!rows.length) {
      await conn.query(`ALTER TABLE movies ${idx.ddl}`);
      console.log(`Added index movies.${idx.name}`);
    }
  }
}

async function ensureColumns(conn) {
  const dbName = process.env.DB_NAME || 'movietracker';
  const added = new Set();
  for (const col of ADDED_COLUMNS) {
    const [rows] = await conn.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'movies' AND column_name = ? LIMIT 1`,
      [dbName, col.name]
    );
    if (!rows.length) {
      await conn.query(`ALTER TABLE movies ${col.ddl}`);
      console.log(`Added column movies.${col.name}`);
      added.add(col.name);
    }
  }
  // Normalize any legacy capitalized format values to the lowercase tokens
  // the UI now uses.
  await conn.query("UPDATE movies SET format='bluray' WHERE format='Blu-ray'");
  await conn.query("UPDATE movies SET format='uhd' WHERE format='UHD'");

  // Backfill the new `formats` array from the single `format` value so older
  // rows immediately show their format in the new multi-format UI.
  if (added.has('formats')) {
    await conn.query(
      "UPDATE movies SET formats = JSON_ARRAY(format) WHERE formats IS NULL"
    );
  }

  // Cheap safety net: if a row has an archived OMDB payload but a missing
  // `imdb_rating` column (e.g. from an external import or an older restore),
  // recover the score from `omdb_raw` without an OMDB call. Note this does NOT
  // help rows the app itself created before the fix — it never persisted
  // `omdb_raw` either, so there's nothing to read. Those are recovered by
  // re-fetching from OMDB via `scripts/backfill-omdb.js`. Idempotent.
  await conn.query(
    `UPDATE movies
        SET imdb_rating = JSON_UNQUOTE(JSON_EXTRACT(omdb_raw, '$.imdbRating'))
      WHERE imdb_rating IS NULL
        AND omdb_raw IS NOT NULL
        AND JSON_UNQUOTE(JSON_EXTRACT(omdb_raw, '$.imdbRating')) NOT IN ('', 'N/A')`
  );

  // Recover IMDb scores stashed in the `ratings` JSON array for rows whose
  // dedicated `imdb_rating` column was never populated. Older inserts only
  // wrote the array, leaving the column blank and `SELECT AVG(imdb_rating)`
  // blind to those titles (and coercing literal '' / 'N/A' rows to zero,
  // which silently drags the SQL average down). The client's
  // discImdbScore() already falls back to the array, so the UI was right —
  // this brings the column into agreement. Idempotent: once the score is
  // promoted, the WHERE clause filters the row out next time.
  // JSON_SEARCH returns the path to the IMDb entry's `source` field, e.g.
  // '"$[0].source"' — swap `.source` for `.value`, pull the value
  // ("6.2/10"), and trim the "/10" suffix.
  await conn.query(
    `UPDATE movies
        SET imdb_rating = SUBSTRING_INDEX(
          JSON_UNQUOTE(JSON_EXTRACT(
            ratings,
            REPLACE(
              JSON_UNQUOTE(JSON_SEARCH(LOWER(ratings), 'one', '%imdb%', NULL, '$[*].source')),
              '.source', '.value'
            )
          )),
          '/',
          1
        )
      WHERE (imdb_rating IS NULL OR TRIM(imdb_rating) IN ('', 'N/A'))
        AND ratings IS NOT NULL
        AND JSON_LENGTH(ratings) > 0
        AND JSON_SEARCH(LOWER(ratings), 'one', '%imdb%', NULL, '$[*].source') IS NOT NULL`
  );

  // Normalize leftover '' / 'N/A' to NULL so a naive
  // SELECT AVG(imdb_rating) FROM movies returns the same number the stats
  // page shows, instead of coercing those non-numeric strings to zero.
  await conn.query(
    `UPDATE movies
        SET imdb_rating = NULL
      WHERE TRIM(IFNULL(imdb_rating, '')) IN ('', 'N/A')`
  );
}

async function initDb({ retries = 10, delayMs = 3000 } = {}) {
  // The DB container may still be starting up when the app boots, so retry.
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const conn = await getPool().getConnection();
      try {
        await conn.query(SCHEMA);
        await ensureColumns(conn);
        await ensureIndexes(conn);
        console.log('Database ready, schema ensured.');
        return;
      } finally {
        conn.release();
      }
    } catch (err) {
      console.warn(
        `DB not ready (attempt ${attempt}/${retries}): ${err.code || err.message}`
      );
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { getPool, initDb };
