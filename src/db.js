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
  title         VARCHAR(255) NOT NULL,
  studio        VARCHAR(255) NULL,
  distributor   VARCHAR(255) NULL,
  format        VARCHAR(32)  NOT NULL DEFAULT 'Blu-ray',
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
  omdb_raw      JSON         NULL,

  created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_title (title),
  INDEX idx_format (format)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function initDb({ retries = 10, delayMs = 3000 } = {}) {
  // The DB container may still be starting up when the app boots, so retry.
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const conn = await getPool().getConnection();
      try {
        await conn.query(SCHEMA);
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
