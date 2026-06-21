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

STACKS is a single-user, self-hosted web app for cataloguing a personal
Blu-ray / 4K UHD / Apple TV media collection (physical discs and digital
purchases alike). It runs on a NAS via Docker
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
  2. A list of idempotent `ALTER TABLE ... ADD COLUMN` calls
     (`ADDED_COLUMNS`) so new columns roll out without manual migrations.
  3. Index creation (`title`, `format`, and the composite `created_at, id`).
  4. `ensureIndexes()` — the same idempotent pattern as `ensureColumns()` but
     for indexes (`ADDED_INDEXES`). MySQL lacks a portable `CREATE INDEX IF NOT
     EXISTS`, so it probes `information_schema.statistics` before adding each
     one. This is how existing installs pick up `idx_created` without a manual
     migration.
- **No ORM, no external migration tool.** When you add a column, add it to
  `ADDED_COLUMNS` so existing deployments pick it up on next boot. Document
  the column in §5 below. New indexes go in `ADDED_INDEXES` the same way.

### 4.3 `src/omdb.js` — OMDB client

- `search(query, { type, year, page })` → `{ results, total }` where
  `results` is the lightweight list (OMDB returns at most 10 per page) and
  `total` is the count OMDB reports for the whole query. `type` is
  whitelisted to `movie` or `series`; the optional `year` maps to OMDB's `y`
  parameter to narrow broad searches. When `total` exceeds `results.length`
  the caller is looking at the top 10 of a larger set.
- `detail(imdbID)` → full record (OMDB's `i` lookup). Normalises OMDB's
  `"N/A"` sentinel into `null`, returns ratings as an array of
  `{ source, value }`. The client also reuses the detail proxy as a direct
  IMDb-ID lookup when the user types a `tt…` code into the search box.
- When OMDB refuses a too-broad query ("Too many results."), the thrown error
  carries `code: 'OMDB_TOO_MANY'` so the search route and client can offer the
  IMDb-ID escape hatch instead of a dead end.
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
| GET    | `/api/discs`                  | list all discs, newest first (lightweight projection — see `LIST_COLUMNS`) |
| GET    | `/api/discs/:id`              | one disc                                         |
| POST   | `/api/discs`                  | create; multipart, optional `image` field        |
| PUT    | `/api/discs/:id`              | update; multipart, optional `image` field        |
| PATCH  | `/api/discs/:id/ripped`       | toggle `ripped` boolean                          |
| DELETE | `/api/discs/:id`              | delete the row and its uploaded image            |
| GET    | `/api/omdb/search?q=&type=&y=` | proxied OMDB search (`type` ∈ `movie`, `series`; optional 4-digit `y` year); returns `{ results, totalResults }`. Errors forward OMDB's `code` (e.g. `OMDB_TOO_MANY`) |
| GET    | `/api/omdb/detail/:imdbID`    | proxied OMDB detail                              |

The list route ships the **entire collection** on every page load, so it
projects an explicit column list (`LIST_COLUMNS`) instead of `SELECT *`. The
projection is exactly the set of columns `toDisc()` reads; it deliberately
omits `omdb_raw` (a full archived OMDB response, kilobytes per row, never sent
to the client) and other detail-only columns (`writer`, `released`, `language`,
`country`, `imdb_rating`, `updated_at`). At ~2000 rows this trims megabytes off
the DB→Node transfer. **If you teach `toDisc()` to read a new column, add it to
`LIST_COLUMNS` too**, or the list will silently return it as `undefined` while
the single-disc route (which still uses `SELECT *`) works fine.

Internal helpers in this module:

- `toDisc(row)` — maps a DB row to the client-facing JSON shape (see §5.2),
  including format-array parsing and poster URL resolution
  (`/uploads/<file>` if `image_file` present, else `poster_url`).
- `bodyToColumns(req.body)` — turns a multipart form body into a column-map
  for INSERT / UPDATE.
- `parseFormats(raw)` — normalises the `formats` array (dedup, whitelist
  against known formats, alphabetical sort so tags display uniformly,
  fallback to `bluray`).
- Catalog code minting: on insert, if no `code` is provided, generate one
  from the primary format (`BD`, `UHD`, `ATV`) plus a zero-padded sequence
  (`BD 044`, `UHD 012`). Codes are preserved on update.
- `findByTitleAndYear(title, year, excludeId)` — case-insensitive, trimmed
  lookup of an existing row whose title AND year both match. A blank year
  matches another blank year but not a populated one, so two releases of
  the same title in different years (e.g. an original and a remake) can
  coexist. POST and PUT call this before writing and reject duplicates
  with HTTP `409` and `{ error, code: 'DUPLICATE_TITLE', duplicateId,
  duplicateTitle }`; PUT passes the current row's id so editing a disc
  without changing its title or year is not treated as a duplicate. The
  client uses `duplicateId` to link from the warning straight to the
  existing disc.

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

Indexes: `title`, `format`, and `idx_created (created_at, id)` — the last backs
the list route's `ORDER BY created_at DESC, id DESC`.

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
- **Add flow**: a two-step modal — OMDB search (with movie/series toggle and
  an optional year field beside the query) then a form pre-filled from the
  chosen result. Posters are sent as URLs; the backend downloads + stores
  them. The search request passes `y=<year>` only when the field holds a
  4-digit value. The server caps each search at OMDB's top 10 results but
  also returns `totalResults`; when that exceeds the number shown, a
  `.results-note` line above the list ("Showing the top N of M matches — add
  a year to narrow it down") nudges the user to use the year field. The search
  box doubles as an IMDb-ID lookup: a query matching `^tt\d+$` skips the title
  search and goes straight to the detail proxy (`lookupByImdb()` →
  `applyDetailToForm()` → details step). When OMDB returns the
  `OMDB_TOO_MANY` error, `state.tooMany` is set and an `.imdb-hint` block
  renders below the error message pointing the user at that IMDb-ID escape
  hatch. Search state lives in `searchQuery`, `searchYear`, `searchType`,
  `results`, `totalResults`, and `tooMany`, all reset on open and on a
  movie/series toggle.
- **Edit flow**: loads the disc, populates the same form, sends a PUT with
  multipart body (image optional).
- **Detail modal**: read-only metadata, ripped toggle, edit & inline-confirm
  delete. For Apple TV-only titles (`!isRippable(d)`) the ripped toggle is
  replaced with a non-interactive `.rip-blocked` notice ("Can't be ripped to
  Plex — Apple TV is digital-only.") in the Apple TV violet accent, since
  digital-only titles can't be ripped. The dialog is a fixed size (`.dialog` has a set `height`, not a
  `max-height`) so it doesn't grow with the synopsis; the plot (`.plot`) lives
  in a fixed-height box that scrolls internally when the text overflows. On
  mobile the layout flips: the dialog is a fixed-height box with
  `overflow: hidden`, the poster (`.detail-cover`) is pulled out of the flow
  and pinned behind the content as a 5%-opacity backdrop
  (`position: absolute; inset: 0`), and `.detail-body` fills the modal as the
  single scroll region. The synopsis loses its internal scroll box (`.plot`
  height is unset) so it flows inline — eliminating the nested
  poster/synopsis/body scroll points in favour of one.
- **Large-catalog performance**: the app loads the whole collection into
  memory and renders client-side, which is designed to stay smooth into the
  low thousands of titles. Three things make that hold: (1) the search box is
  **debounced** — `onInput()` updates `state.query` immediately but defers the
  expensive `renderContent()` rebuild by 120 ms, so typing doesn't rebuild the
  wall on every keystroke (the search input lives in the toolbar, which
  `renderContent()` never touches, so it keeps focus across renders); (2) card
  posters are lazy (`loading="lazy" decoding="async"`, see `posterOrHouse()`)
  so a wall of ~2000 cards doesn't fetch/decode every image up front; (3) the
  off-screen skipping in CSS (`content-visibility`, see §6.3) means only
  on-screen cards/spines cost layout and paint. The backend half of this is the
  `LIST_COLUMNS` projection (see §4.5).
- **Filter / sort**: `filteredSorted()` runs client-side; an O(n log n) pass
  that stays cheap into the low thousands of titles. Sort options (`SORT_OPTIONS`, the single source of
  truth for the toolbar `<select>` and for validating persisted values):
  `added` (recently added, default order), `title` (**default** — "Title
  A–Z", alphabetises on the real title via `realTitle()`, which strips a
  leading article ("The ", "A ", "An ") and ignores any custom sort
  title), `title-custom` ("Title A–Z (Custom)", alphabetises on
  `sortableTitle()`, which honours a disc's custom sort title), and `year`
  (newest first). The alphabetical sorts use `localeCompare` with
  `{ numeric: true }` so embedded numbers compare numerically — "21 Jump
  Street" sorts before "2001: A Space Odyssey" rather than after.
  `sortKeyTitle()` returns the title the active sort groups by (custom title
  for `title-custom`, real title otherwise) and backs both the wall's A–Z
  letter buckets and its jump index.
- **Session settings**: `state.settings` holds per-browser user preferences,
  persisted to `localStorage` under the `stacks.settings` key (`loadSettings()`
  / `saveSettings()`, defaults in `DEFAULT_SETTINGS`). The first stored
  preference is the active title `sort`; it is read on boot (validated against
  `SORT_OPTIONS`, falling back to the default if unknown) and rewritten
  whenever the sort `<select>` changes. There is no server-side persistence —
  these settings live only in the browser. Add future preferences as new keys
  on `DEFAULT_SETTINGS`.
- **Stats view**: aggregates totals, runtime, average IMDb rating, top
  genres / directors / studios / decades — all computed in-browser. The
  Plex-status figures (the "Ripped to Plex" headline stat and the "Plex
  status" panel) only count *rippable* titles: Apple TV is digital-only and
  can't be ripped, so titles held solely in the Apple TV format are excluded
  (see `isRippable()`). A title in both a physical format and Apple TV still
  counts.
- **Poster fallback**: if a `<img>` fires `error`, a deterministic
  house-style cover (hue derived from the title hash) is rendered in its
  place.
- **A–Z jump index**: when the wall view is sorted by either title sort
  (`title` or `title-custom`), a `#`–`Z` column is rendered to the right of
  the grid. It uses `position: fixed` so it stays anchored at the right edge
  of the centred page wrap and doesn't scroll away when the user reaches the
  bottom of the list; the wall reserves a right-side gutter so cards don't
  slide under it. Letters with no matching disc are dimmed; clicking an
  active letter scrolls the page so the first card whose active-sort title
  (`sortKeyTitle()`) starts with it sits just below the sticky header. Cards
  carry a `data-letter` attribute so the jump can use a simple
  `querySelector`. The index is hidden for year / recently-added sorts
  because first letters no longer correlate with row order.
- **Add modal autofocus**: opening the Add Disc modal focuses the OMDb
  search field immediately so the user can start typing without clicking.
- **Mobile menu**: on narrow viewports the toolbar's filter / sort / view
  controls (`.toolbar-right`) collapse behind a `☰ Menu` button rendered
  between the search field and the controls. `state.menuOpen` toggles a
  `.open` class on both the button and `.toolbar-right`; the controls render
  as a full-width dropdown column below the search row when open. On desktop
  the menu button is hidden and the controls show inline as before. The
  header renders the brand, the stats strip, and the Add button as three
  direct children of `.header` (no `.header-right` wrapper) so that, on
  mobile, the brand and Add button share the top row while the stats reflow
  to a compact full-width strip beneath them.
- **Duplicate-title guard**: when a save returns `409 DUPLICATE_TITLE`,
  the details form stays open, the title input is focused and selected,
  and a red inline warning is rendered above the fields with a
  `View "<existing>"` link that closes the add modal and opens the
  matching disc. The user edits the title in place to clear it, or
  closes the modal via the ✕ / Escape. `state.duplicateWarning` holds
  `{ message, id, title }` and is cleared on open/close/save. `api()`
  attaches the full parsed error body as `err.data` so the handler can
  read `duplicateId` / `duplicateTitle`.

### 6.3 `styles.css`

Single monolithic dark theme. Format-coded accents — amber for UHD, blue
for Blu-ray, violet for Apple TV. CSS custom properties (`--accent`) drive
per-format colouring; the wall grid is `repeat(auto-fill, minmax(155px, 1fr))`.

`.card` and `.spine` set `content-visibility: auto` with a `contain-intrinsic-size`
placeholder (`auto 260px` for cards, the fixed `52px 288px` for spines) so the
browser skips layout and paint for off-screen items — near-virtualization for
the wall/shelf that keeps the A–Z jump and in-page find working because every
node still exists in the DOM. The intrinsic size is tuned to the real rendered
card height so the scrollbar and `jumpToLetter()` offsets stay accurate.

The header + toolbar are wrapped in a `.site-header` container that uses
`position: sticky; top: 0` with a translucent backdrop-blurred background,
so the brand, stats, add button, search, and view controls stay pinned to
the top of the viewport while only the wall / shelf / stats content
scrolls beneath them.

A single `@media (max-width: 720px)` block makes the layout
mobile-friendly: the sticky header is compacted (smaller brand, the stats
collapse into a single full-width strip, a slimmer Add button), the toolbar
controls hide behind the `.menu-toggle` button and reflow into a stacked
full-width dropdown when opened, the A–Z index is hidden (and its
right-side gutter removed), and the wall grid switches to a fixed
three-up layout (`repeat(3, 1fr)`). The same query also stacks the
detail/add modals.

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
  normaliser. The array is stored and returned alphabetically sorted, so the
  primary format is the alphabetically-first owned format (e.g. a Blu-ray +
  UHD title shows `bluray` as primary and accents with the blue colour).
- **Posters.** `/uploads/<image_file>` if uploaded; otherwise `poster_url`;
  otherwise the client renders a generated cover. The backend prefers a
  local copy of OMDB posters and downloads them on add.
- **Error shape.** Server errors are JSON `{ error: "message" }` with
  appropriate status. Errors that the client needs to branch on also carry
  a machine-readable `code` (e.g. `DUPLICATE_TITLE`) plus any extra fields
  (e.g. `duplicateId`); the client's `api()` helper attaches `err.status`,
  `err.code`, and the full parsed body as `err.data` to the thrown
  `Error` so callers can react. Client throws on `!ok` and surfaces the
  message in the UI.
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

*Last revised: 2026-06-21 (detail modal now replaces the ripped toggle with a
`.rip-blocked` notice for Apple TV-only titles, which are digital-only and can't
be ripped to Plex. Previous: large-catalog performance pass for ~2000-title collections:
the list route now projects an explicit `LIST_COLUMNS` set instead of `SELECT *` (drops the
heavy unused `omdb_raw` and other detail-only columns); added the `idx_created (created_at, id)`
index via a new idempotent `ensureIndexes()`/`ADDED_INDEXES` path; the client lazy-loads card
posters, debounces the search box, and uses `content-visibility` on cards/spines to skip
off-screen layout & paint. Previous: dashboard Plex-status figures now exclude Apple TV-only titles, which can't be ripped, via `isRippable()`; OMDB search gained an optional year filter (`y`) and now returns `totalResults` so the add modal can show "top 10 of N" when a search is too broad; the search box accepts an IMDb ID (`tt…`) for a direct lookup and surfaces that escape hatch when OMDB returns "Too many results"; alphabetical sorts now strip a leading "A "/"An " article in addition to "The "; session settings persisted to localStorage starting with the title sort; added a real-title "Title A–Z" default sort alongside the custom-aware "Title A–Z (Custom)").*


