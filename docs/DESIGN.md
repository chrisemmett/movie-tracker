# STACKS — Low-Level Design

This is a retroactive low-level design (LLD) for the STACKS movie-tracker
application. It exists so future contributors — humans and LLMs — can navigate
the codebase quickly without re-deriving how the pieces fit together.

> **Keep this design current.** Any change that adds, removes, or alters a
> route, table column, module responsibility, data shape, environment
> variable, build/deploy step, or external dependency MUST be reflected here
> in the same change. Treat the design as part of the code: a PR that
> modifies behaviour without updating this document is incomplete.

---

## 1. Purpose & scope

STACKS is a single-user, self-hosted web app for cataloguing a physical
Blu-ray / 4K UHD / Apple TV media collection. It runs on a NAS via Docker
Compose, persists to MySQL, stores cover art on a Docker volume, and enriches
each entry from the OMDB API. There is no authentication — it assumes a
trusted LAN.

Non-goals: multi-tenant accounts, social features, mobile-native clients,
real-time sync. The architecture is deliberately small and boring.

---

## 2. High-level architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                      Browser (vanilla JS SPA)                        │
│   public/index.html  +  public/app.js  +  public/styles.css          │
└──────────────────────────────────────────────────────────────────────┘
                              │  fetch() JSON / multipart
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      Node.js / Express server                        │
│   src/server.js  →  src/routes/discs.js  →  src/db.js / omdb.js      │
└─────────────────────┬───────────────────────────────┬────────────────┘
                      │                               │
                      ▼                               ▼
            ┌──────────────────┐            ┌──────────────────┐
            │   MySQL 8        │            │  OMDB API        │
            │   `movies` table │            │  (server-side)   │
            └──────────────────┘            └──────────────────┘

            ┌──────────────────┐
            │  Upload volume   │ ← Multer-written cover art &
            │  /data/uploads   │   downloaded OMDB posters
            └──────────────────┘
```

Both services (`app`, `db`) and both named volumes (`db_data`,
`uploads_data`) live in `docker-compose.yml`.

---

## 3. Repository layout

```
movie-tracker/
├── src/                      Backend (Node 18+, CommonJS, Express)
│   ├── server.js             App bootstrap, middleware, SPA fallback
│   ├── db.js                 MySQL pool + idempotent schema/migrations
│   ├── omdb.js               OMDB API client (search + detail)
│   ├── upload.js             Multer config + image download/cleanup
│   └── routes/
│       └── discs.js          All REST routes (/api/discs/*, /api/omdb/*)
├── public/                   Frontend (no build step)
│   ├── index.html            Single HTML shell, mounts <div id="app">
│   ├── app.js                Vanilla-JS SPA (~750 lines, IIFE)
│   └── styles.css            Monolithic dark theme stylesheet
├── scripts/
│   ├── backup.sh             mysqldump + tar of uploads → backups/<ts>/
│   └── restore.sh            Restore a backup snapshot
├── docs/
│   └── DESIGN.md             ← this document
├── Dockerfile                Node 20-alpine, omit=dev
├── docker-compose.yml        app + db, named volumes
├── .env.example              Required configuration template
└── package.json              start / dev scripts; no devDependencies
```

There is no transpiler, bundler, test runner, linter, or formatter
configured. Backend is CommonJS; frontend is a hand-written IIFE.

---

## 4. Backend modules

### 4.1 `src/server.js` — entry point

- Loads `.env` via `dotenv`.
- Mounts `express.json()` and serves `public/` and `UPLOAD_DIR` as static.
- Mounts the disc router under `/api`.
- SPA fallback: any non-`/api/*` GET serves `public/index.html`; unknown
  `/api/*` paths return JSON `404`.
- Global error handler turns thrown errors into `{ error }` JSON, honouring
  `err.status` if set.
- `initDb()` is called before `app.listen(PORT)`; the server only binds once
  the database is reachable.

### 4.2 `src/db.js` — persistence layer

- Lazy `getPool()` returns a singleton `mysql2/promise` pool (max 10
  connections).
- `initDb()` retries the connection (10 × 3s backoff) until MySQL is ready,
  then runs:
  1. `CREATE TABLE IF NOT EXISTS movies (...)` — base schema.
  2. A list of idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` calls
     (`ADDED_COLUMNS`) so new columns roll out without manual migrations.
  3. Index creation (`title`, `format`).
- **No ORM, no external migration tool.** When you add a column, add it to
  `ADDED_COLUMNS` so existing deployments pick it up on next boot. Document
  the column in §5 below.

### 4.3 `src/omdb.js` — OMDB client

- `search(query, { type, page })` → lightweight result list. `type` is
  whitelisted to `movie` or `series`.
- `detail(imdbID)` → full record. Normalises OMDB's `"N/A"` sentinel into
  `null`, returns ratings as an array of `{ source, value }`.
- The OMDB API key lives only on the server (`OMDB_API_KEY` env var). The
  browser never sees it; the frontend always goes through the proxy routes.
- Missing/invalid key surfaces as a `503` from the proxy routes.

### 4.4 `src/upload.js` — image handling

- Multer disk storage. Filenames are `<timestamp>-<random>.<ext>`.
- MIME whitelist: `image/jpeg`, `image/png`, `image/webp`, `image/gif`.
- Hard size limit: 10 MB.
- `downloadImage(url)` fetches an external poster (e.g. from OMDB), validates
  the MIME, and writes a local copy so cover art keeps working even if OMDB
  is unreachable later. Best-effort: failures are swallowed.
- `removeImage(filename)` is fire-and-forget cleanup used on delete / replace.

### 4.5 `src/routes/discs.js` — HTTP API

| Method | Path                          | Purpose                                          |
| ------ | ----------------------------- | ------------------------------------------------ |
| GET    | `/api/discs`                  | list all discs, newest first                     |
| GET    | `/api/discs/:id`              | one disc                                         |
| POST   | `/api/discs`                  | create; multipart, optional `image` field        |
| PUT    | `/api/discs/:id`              | update; multipart, optional `image` field        |
| PATCH  | `/api/discs/:id/ripped`       | toggle `ripped` boolean                          |
| DELETE | `/api/discs/:id`              | delete the row and its uploaded image            |
| GET    | `/api/omdb/search?q=&type=`   | proxied OMDB search (`type` ∈ `movie`, `series`) |
| GET    | `/api/omdb/detail/:imdbID`    | proxied OMDB detail                              |

Internal helpers in this module:

- `toDisc(row)` — maps a DB row to the client-facing JSON shape (see §5.2),
  including format-array parsing and poster URL resolution
  (`/uploads/<file>` if `image_file` present, else `poster_url`).
- `bodyToColumns(req.body)` — turns a multipart form body into a column-map
  for INSERT / UPDATE.
- `parseFormats(raw)` — normalises the `formats` array (dedup, whitelist
  against known formats, fallback to `bluray`).
- Catalog code minting: on insert, if no `code` is provided, generate one
  from the primary format (`BD`, `UHD`, `ATV`) plus a zero-padded sequence
  (`BD 044`, `UHD 012`). Codes are preserved on update.

Errors thrown from handlers receive HTTP status from `err.status`; the global
handler in `server.js` JSON-encodes them.

---

## 5. Data model

### 5.1 `movies` table (MySQL)

The whole app is one table. Each row is one physical disc.

| Column        | Type                | Notes                                                  |
| ------------- | ------------------- | ------------------------------------------------------ |
| `id`          | INT AUTO_INCREMENT  | primary key                                            |
| `code`        | VARCHAR(32)         | e.g. `BD 044`; auto-minted if not supplied              |
| `title`       | VARCHAR(255) NOT NULL | display title                                        |
| `sort_title`  | VARCHAR(255)        | optional custom sort key                                |
| `year`        | VARCHAR(16)         | release year (string for OMDB compatibility)           |
| `format`      | VARCHAR(32) NOT NULL | primary format; default `bluray`                      |
| `formats`     | JSON                | array of formats for multi-edition ownership            |
| `studio`      | VARCHAR(255)        | production studio                                       |
| `distributor` | VARCHAR(255)        | disc label                                              |
| `ripped`      | TINYINT(1) NOT NULL | "Ripped to Plex" flag; default 0                       |
| `image_file`  | VARCHAR(255)        | uploaded cover filename on the volume                  |
| `poster_url`  | TEXT                | OMDB poster URL fallback                                |
| `imdb_id`     | VARCHAR(20)         | IMDb id from OMDB                                       |
| `director`    | VARCHAR(255)        |                                                         |
| `actors`      | TEXT                | cast string from OMDB                                   |
| `plot`        | TEXT                |                                                         |
| `genre`       | VARCHAR(255)        | comma-separated                                         |
| `runtime`     | VARCHAR(32)         | e.g. "120 min"                                          |
| `rated`       | VARCHAR(32)         | MPAA rating                                             |
| `language`    | VARCHAR(255)        |                                                         |
| `country`     | VARCHAR(255)        |                                                         |
| `imdb_rating` | VARCHAR(16)         | e.g. "8.2"                                              |
| `ratings`     | JSON                | array of `{ source, value }` from OMDB                  |
| `omdb_raw`    | JSON                | archived raw OMDB response                              |
| `created_at`  | TIMESTAMP           | defaults to now                                         |
| `updated_at`  | TIMESTAMP           | auto-updates                                            |

Indexes: `title`, `format`.

**When adding a column:** add the `ALTER TABLE` to `ADDED_COLUMNS` in
`src/db.js`, surface it through `toDisc()` and `bodyToColumns()` in
`src/routes/discs.js`, and document it in the table above.

### 5.2 Client-side disc shape

`toDisc()` returns this JSON to the browser:

```js
{
  id, code, addedAt,        // numeric id, catalog code, ms epoch
  title, sortTitle, year,
  format, formats,          // string + array
  studio, distributor,
  ripped,                   // boolean
  poster, hasUpload,        // URL string + boolean (true if user-uploaded)
  director, cast, plot,
  genre, runtime, rated,
  ratings,                  // array of { source, value }
  imdbID
}
```

Fields are renamed (`actors` → `cast`, `imdb_id` → `imdbID`, `created_at` →
`addedAt`) — keep `toDisc()` as the single source of truth for the wire shape.

---

## 6. Frontend (public/)

### 6.1 Shell

`index.html` is intentionally minimal: it links Google Fonts (Barlow
Condensed, Barlow, Space Mono) and `styles.css`, exposes a single
`<div id="app">`, and loads `app.js`.

### 6.2 `app.js` — vanilla SPA

The whole frontend is one IIFE with no framework. Key pieces:

- **State tree** (single object): `discs`, `view` (`wall` | `shelf` |
  `stats`), `query`, `fmt` (format filter), `plex` (Plex-status filter:
  `all` | `plex` | `not-plex`), `sort`, `detailId`, `addOpen`, `editId`,
  plus form/search sub-states.
- **Rendering**: pure functions per region — `renderHeader()`,
  `renderToolbar()`, `renderContent()`, `renderModals()` — that build HTML
  strings and assign them via `innerHTML`. Re-renders happen by calling
  these after each state mutation; the whole region is replaced (no diff).
- **Event handling**: delegated through `[data-action]` attributes on a
  single root listener. New actions are added by adding `data-action="…"` to
  the markup and a case in the dispatcher.
- **API layer**: `api(path, opts)` wraps `fetch` with JSON parsing and
  throws on `!response.ok`.
- **Add flow**: a two-step modal — OMDB search (with movie/series toggle)
  then a form pre-filled from the chosen result. Posters are sent as URLs;
  the backend downloads + stores them.
- **Edit flow**: loads the disc, populates the same form, sends a PUT with
  multipart body (image optional).
- **Detail modal**: read-only metadata, ripped toggle, edit & inline-confirm
  delete.
- **Filter / sort**: `filteredSorted()` runs client-side; OK because the
  collection is small. The title sort uses `localeCompare` with
  `{ numeric: true }` so embedded numbers compare numerically — "21 Jump
  Street" sorts before "2001: A Space Odyssey" rather than after.
- **Stats view**: aggregates totals, runtime, average IMDb rating, top
  genres / directors / studios / decades — all computed in-browser.
- **Poster fallback**: if a `<img>` fires `error`, a deterministic
  house-style cover (hue derived from the title hash) is rendered in its
  place.
- **A–Z jump index**: when the wall view is sorted by title, a `#`–`Z`
  column is rendered to the right of the grid. It uses `position: fixed`
  so it stays anchored at the right edge of the centred page wrap and
  doesn't scroll away when the user reaches the bottom of the list; the
  wall reserves a right-side gutter so cards don't slide under it.
  Letters with no matching disc are dimmed; clicking an active letter
  scrolls the page so the first card whose sortable title starts with it
  sits just below the sticky header. Cards carry a `data-letter`
  attribute so the jump can use a simple `querySelector`. The index is
  hidden for year / recently-added sorts because first letters no longer
  correlate with row order.
- **Add modal autofocus**: opening the Add Disc modal focuses the OMDb
  search field immediately so the user can start typing without clicking.

### 6.3 `styles.css`

Single monolithic dark theme. Format-coded accents — amber for UHD, blue
for Blu-ray, violet for Apple TV. CSS custom properties (`--accent`) drive
per-format colouring; the wall grid is `repeat(auto-fill, minmax(155px, 1fr))`.

The header + toolbar are wrapped in a `.site-header` container that uses
`position: sticky; top: 0` with a translucent backdrop-blurred background,
so the brand, stats, add button, search, and view controls stay pinned to
the top of the viewport while only the wall / shelf / stats content
scrolls beneath them.

---

## 7. Runtime & deployment

### 7.1 Local development

```bash
npm install
cp .env.example .env       # set OMDB_API_KEY, DB_*, UPLOAD_DIR
npm run dev                # node --watch src/server.js
```

Requires Node 18+ and a reachable MySQL.

### 7.2 Production (NAS)

```bash
docker compose up -d --build
```

`Dockerfile` is a single-stage `node:20-alpine` image with
`npm ci --omit=dev`. `docker-compose.yml` defines:

- `app` service: built locally, port `${APP_PORT:-3000}:3000`, mounts the
  `uploads_data` volume at `/data/uploads`.
- `db` service: `mysql:8`, mounts `db_data` at `/var/lib/mysql`.

Both volumes are **named** (not bind mounts) so they survive routine
restarts but are erased by `docker compose down -v` or `docker volume rm`.

### 7.3 Backup / restore

- `scripts/backup.sh` writes `backups/<UTC-timestamp>/db.sql` (via
  `mysqldump` inside the `db` container) and `uploads.tar.gz`.
- `scripts/restore.sh <dir>` restores both, prompting before overwriting.

### 7.4 CI / publishing

`.github/workflows/publish.yml` builds and pushes the Docker image to
`ghcr.io/chrisemmett/movie-tracker` on push to `main` or a tag, using Docker
Buildx with `type=gha` cache. No tests run in CI (there are none).

---

## 8. Configuration

| Variable        | Default          | Required | Purpose                            |
| --------------- | ---------------- | -------- | ---------------------------------- |
| `APP_PORT`      | `3000`           | No       | Host port published by compose     |
| `PORT`          | `3000`           | No       | Port the Node app binds            |
| `DB_HOST`       | `db`             | No       | MySQL hostname                     |
| `DB_PORT`       | `3306`           | No       | MySQL port                         |
| `DB_NAME`       | `movietracker`   | No       | MySQL database                     |
| `DB_USER`       | `movietracker`   | No       | MySQL user                         |
| `DB_PASSWORD`   | `movietracker`   | No       | MySQL password                     |
| `UPLOAD_DIR`    | `/data/uploads`  | No       | Where covers are written           |
| `OMDB_API_KEY`  | _(none)_         | **Yes**  | OMDB key; routes return 503 if absent |

`.env` is consumed by both `docker-compose.yml` (for `db` defaults and
`APP_PORT`) and the Node app (for everything else).

---

## 9. Cross-cutting conventions

- **Multipart on writes.** Create/update accept `multipart/form-data` with
  an optional `image` part. PATCH/DELETE/GET use JSON.
- **`format` vs `formats`.** Single primary format string + JSON array of all
  formats owned. Always keep them in sync; `parseFormats()` is the
  normaliser.
- **Posters.** `/uploads/<image_file>` if uploaded; otherwise `poster_url`;
  otherwise the client renders a generated cover. The backend prefers a
  local copy of OMDB posters and downloads them on add.
- **Error shape.** Server errors are JSON `{ error: "message" }` with
  appropriate status. Client throws on `!ok` and surfaces the message in the
  UI.
- **No auth, no rate limiting.** Designed for a trusted LAN. Put it behind a
  reverse proxy / VPN if you expose it.
- **Schema migrations.** Idempotent and additive only. There is no
  destructive migration path; if you need to drop or rename a column, write
  a one-off script and document it here.

---

## 10. Extending the app — checklist

When you add a feature:

1. **Schema** — add the column to `ADDED_COLUMNS` in `src/db.js` and to the
   table in §5.1 above.
2. **API** — wire it through `bodyToColumns()` and `toDisc()` in
   `src/routes/discs.js`; if you add a route, update §4.5 and the README.
3. **Client** — surface it in state, render path, and the add/edit form in
   `public/app.js`.
4. **Styles** — extend `public/styles.css`; reuse CSS variables and the
   existing format accent system.
5. **Docs** — update **this file** and the README. Any new env var also
   goes into `.env.example`.
6. **Backup compatibility** — confirm `mysqldump` / `tar` based backup still
   captures the new state (it almost certainly will; flag any exception).

---

*Last revised: 2026-06-19.*


