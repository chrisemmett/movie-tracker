#!/usr/bin/env node
/*
 * One-off maintenance: backfill the IMDb score for titles that were saved
 * before the app persisted it.
 *
 * Why this is needed
 * ------------------
 * OMDB returns the IMDb score in two places: a top-level `imdbRating` field
 * (populated for almost every title) and a `Ratings` array (frequently empty
 * for less-mainstream releases). Early versions of the app stored only the
 * `Ratings` array and dropped both the top-level `imdbRating` AND the raw
 * payload (`omdb_raw`) on the floor. So any title whose `Ratings` array came
 * back empty has no IMDb score stored anywhere locally — which silently
 * excludes it from the stats "Avg IMDb rating", pinning the average no matter
 * how many titles you add.
 *
 * There is no offline source to recover those scores from (omdb_raw is empty
 * too), so this script re-fetches each affected title from OMDB by its
 * `imdb_id` and writes back `imdb_rating`, `ratings`, and `omdb_raw`. Rows that
 * already have a score, or that have no `imdb_id` to look up, are left alone.
 *
 * Usage (inside the app container, which has DB env + OMDB_API_KEY):
 *   node scripts/backfill-omdb.js            # backfill everything missing
 *   node scripts/backfill-omdb.js --dry-run  # report only, no writes/fetches
 *   node scripts/backfill-omdb.js --limit 50 # cap the number of rows touched
 *
 * Idempotent: safe to re-run. It only targets rows still missing a score, so a
 * second run continues where an interrupted/rate-limited first run left off.
 */

require('dotenv').config();

const { getPool } = require('../src/db');
const omdb = require('../src/omdb');

const DELAY_MS = Number(process.env.BACKFILL_DELAY_MS || 150);
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A row is "missing a score" when neither the dedicated imdb_rating column nor
// the ratings array carries a usable IMDb number. Mirrors the client's
// discImdbScore() so what we backfill is exactly what the stats can't see.
const NEEDS_BACKFILL = `
  (imdb_rating IS NULL OR TRIM(imdb_rating) IN ('', 'N/A'))
  AND (
    ratings IS NULL
    OR JSON_LENGTH(ratings) = 0
    OR JSON_SEARCH(LOWER(ratings), 'one', '%imdb%', NULL, '$[*].source') IS NULL
  )
`;

async function main() {
  const pool = getPool();

  const [[summary]] = await pool.query(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN ${NEEDS_BACKFILL} THEN 1 ELSE 0 END) AS missing,
       SUM(CASE WHEN (${NEEDS_BACKFILL})
                 AND imdb_id IS NOT NULL AND TRIM(imdb_id) <> ''
                THEN 1 ELSE 0 END) AS fixable
     FROM movies`
  );
  console.log(
    `Collection: ${summary.total} titles, ${Number(summary.missing)} missing an IMDb score, ` +
    `${Number(summary.fixable)} of those have an imdb_id to look up.`
  );

  if (!Number(summary.fixable)) {
    console.log('Nothing to backfill. Done.');
    await pool.end();
    return;
  }
  if (DRY_RUN) {
    console.log('--dry-run: no OMDB calls or writes performed.');
    await pool.end();
    return;
  }

  const [rows] = await pool.query(
    `SELECT id, imdb_id, title FROM movies
      WHERE (${NEEDS_BACKFILL})
        AND imdb_id IS NOT NULL AND TRIM(imdb_id) <> ''
      ORDER BY id`
  );

  let fixed = 0;
  let stillEmpty = 0;
  let failed = 0;
  const targets = rows.slice(0, LIMIT);

  for (let i = 0; i < targets.length; i++) {
    const row = targets[i];
    const tag = `[${i + 1}/${targets.length}] ${row.title} (${row.imdb_id})`;
    try {
      const d = await omdb.detail(row.imdb_id);
      const score = (d.imdb_rating || '').trim();
      if (!score || score === 'N/A') {
        stillEmpty++;
        console.log(`${tag} — OMDB has no imdbRating, skipped`);
      } else {
        await pool.query(
          'UPDATE movies SET imdb_rating = ?, ratings = ?, omdb_raw = ? WHERE id = ?',
          [score, JSON.stringify(d.ratings || []), JSON.stringify(d.omdb_raw || null), row.id]
        );
        fixed++;
        console.log(`${tag} → ${score}`);
      }
    } catch (err) {
      failed++;
      console.warn(`${tag} — lookup failed: ${err.message}`);
    }
    if (i < targets.length - 1) await sleep(DELAY_MS);
  }

  console.log(
    `\nDone. ${fixed} scored, ${stillEmpty} had no OMDB score, ${failed} failed.` +
    (targets.length < rows.length ? ` (${rows.length - targets.length} left — re-run to continue.)` : '')
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
