# 🎞 STACKS — Media Library

A self-hosted web app for cataloguing a personal **Blu-ray / 4K UHD / Apple TV**
media collection (physical discs and digital purchases alike). Built to run in
Docker on a NAS with a MySQL database. Browse your collection as a **poster
wall**, a **shelf of spines**, or a **stats dashboard**; track
studio/distributor, flag which titles are **ripped to Plex**, upload your own
cover art, and enrich each entry with data pulled from
[OMDB](https://www.omdbapi.com/) and stored locally.

## Features

- Track **title, sort title, year, studio, distributor/label, and format(s)**.
  A single title can own **multiple formats** at once (e.g. a Blu-ray *and* a
  4K UHD edition); supported formats are **Blu-ray**, **4K UHD**, and
  **Apple TV**, each colour-coded (blue / amber / violet)
- **Ripped to Plex** flag, toggleable inline from the detail view
- **Three views** of the collection, with a generated catalog code per entry
  (`BD 044` / `UHD 012` / `ATV 007`):
  - a poster **wall** grid (with an **A–Z jump index** when sorted by title)
  - a **shelf** of vertical spines, colour-coded by format
  - a **stats** dashboard — totals, combined runtime, average IMDb rating, and
    top genres / directors / studios / decades, all computed in-browser
- **Upload cover art** — stored on a Docker volume on your NAS. When you add a
  title via OMDB, its poster is **copied to your NAS** too, so cover art keeps
  working even if OMDB is down. Falls back to a generated house-style cover when
  no image exists
- **OMDB search-and-pick on add**: search by title for either a movie or a TV
  series, choose the match, and details (studio, director, cast, plot, genre,
  runtime, rating, language, country, and review scores) are fetched and saved
  locally so they don't depend on OMDB later
- **Search**, **format filtering**, **Plex-status filtering** (all / ripped /
  not ripped), and **sorting** (recently added / title A–Z / year newest)
- **Duplicate guard** — adding or editing a title that already exists (same
  title + year) is blocked with an inline warning that links straight to the
  existing entry
- Detail modal with metadata, review-score row, edit, and inline-confirm delete
- **Mobile-friendly** responsive layout — a sticky header, a collapsible
  toolbar menu, and a three-up wall grid on narrow screens

## Stack

- Node.js + Express JSON API, MySQL 8 for persistence
- Vanilla-JS single-page frontend (no build step) matching the STACKS design
- `multer` for image uploads to a mounted volume
- Packaged with Docker Compose (app + db)

The OMDB API key stays **server-side** (in `.env`); the browser never sees it —
lookups are proxied through the app.

## Quick start (Docker, recommended for the NAS)

1. Get a free OMDB API key: https://www.omdbapi.com/apikey.aspx
2. Copy the env file and fill it in:

   ```bash
   cp .env.example .env
   # edit .env — set OMDB_API_KEY and change the passwords
   ```

3. Bring up the stack:

   ```bash
   docker compose up -d --build
   ```

4. Open `http://<your-nas-ip>:3000`.

### Where data lives (and how to not lose it)

Both the database and your uploaded cover images live in **named Docker
volumes**, managed by Docker and stored under its data root on the NAS:

| What         | Container path   | Named volume    |
| ------------ | ---------------- | --------------- |
| MySQL data   | `/var/lib/mysql` | `db_data`       |
| Cover images | `/data/uploads`  | `uploads_data`  |

These **survive** `docker compose up -d --build`, `docker compose restart`, and
`docker compose down`. The only things that delete them are explicit:

> ⚠️ **`docker compose down -v`** (the `-v`/`--volumes` flag) and
> `docker volume rm` **erase your collection.** Use plain `docker compose down`
> to stop the stack.

Take a snapshot any time with the backup helper below — that's the durable copy
you can keep off the NAS or in source control of your own.

> Upgrading from an earlier version that used `./data`? Your data was in
> `./data/mysql` and `./data/uploads`. After switching to named volumes those
> folders are no longer used; once you've confirmed the new setup works you can
> delete the old `./data` directory.

## Backup & restore

Two helper scripts (run the stack first with `docker compose up -d`):

```bash
# Snapshot DB + cover images to backups/<timestamp>/
./scripts/backup.sh

# Restore a snapshot (prompts before overwriting current data)
./scripts/restore.sh backups/20260619-120000
```

`backup.sh` writes a logical `db.sql` dump (via `mysqldump`) plus a
`uploads.tar.gz` of your cover art. Keep the `backups/` folder somewhere safe —
it's git-ignored, so it won't be committed. For a one-off manual DB dump:

```bash
docker compose exec -T db mysqldump -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" > db.sql
```

## Running locally without Docker

You need Node 18+ and a reachable MySQL instance.

```bash
npm install
cp .env.example .env   # set DB_* to point at your MySQL, set OMDB_API_KEY

export DB_HOST=127.0.0.1 DB_USER=movietracker DB_PASSWORD=... DB_NAME=movietracker
export OMDB_API_KEY=yourkey
export UPLOAD_DIR=./data/uploads

npm start
```

The schema is created (and migrated) automatically on startup.

## Data model

A single `movies` table. Each row is a disc:

| Field | Notes |
| --- | --- |
| `title`, `sort_title`, `year` | basic identity (`sort_title` is an optional custom sort key) |
| `format` | primary format: `bluray`, `uhd`, or `appletv` |
| `formats` | JSON array of all formats owned, for multi-edition titles |
| `studio`, `distributor` | production studio + disc label |
| `ripped` | "Ripped to Plex" flag |
| `code` | auto-generated catalog code, e.g. `BD 044` / `UHD 012` / `ATV 007` |
| `image_file` | uploaded cover stored on the NAS volume |
| `poster_url` | OMDB poster reference |
| `director`, `actors` (cast), `plot`, `genre`, `runtime`, `rated`, `language`, `country`, `imdb_rating` | from OMDB |
| `ratings` | JSON array of `{source, value}` review scores |
| `imdb_id`, `omdb_raw` | IMDb id + archived raw OMDB payload |

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/discs` | list all discs |
| GET | `/api/discs/:id` | one disc |
| POST | `/api/discs` | create (multipart; optional `image`). Returns `409` with `code: DUPLICATE_TITLE` if a title+year match already exists |
| PUT | `/api/discs/:id` | update (multipart; optional `image`). Same `409` duplicate guard, excluding the row being edited |
| PATCH | `/api/discs/:id/ripped` | set the ripped flag (`{ripped:bool}`) |
| DELETE | `/api/discs/:id` | delete (also removes its uploaded image) |
| GET | `/api/omdb/search?q=&type=` | proxied OMDB title search (`type` is `movie` or `series`, default `movie`) |
| GET | `/api/omdb/detail/:imdbID` | proxied OMDB detail lookup |

## Configuration

| Variable          | Default        | Purpose                                   |
| ----------------- | -------------- | ----------------------------------------- |
| `APP_PORT`        | `3000`         | Host port (compose)                       |
| `PORT`            | `3000`         | Port the app listens on                   |
| `DB_HOST`         | `db`           | MySQL host                                |
| `DB_PORT`         | `3306`         | MySQL port                                |
| `DB_NAME`         | `movietracker` | Database name                             |
| `DB_USER`         | `movietracker` | Database user                             |
| `DB_PASSWORD`     | `movietracker` | Database password                         |
| `UPLOAD_DIR`      | `/data/uploads`| Where cover images are written            |
| `OMDB_API_KEY`    | _(required)_   | OMDB API key for lookups                  |

## Design

See [`docs/DESIGN.md`](docs/DESIGN.md) for a low-level architectural
walkthrough — repository layout, module responsibilities, data model, and
extension checklist. **All new changes must be reflected in that document.**

## Notes

- The OMDB poster URL is saved as a reference; an uploaded cover takes precedence.
- Image uploads are limited to 10 MB and to JPEG/PNG/WebP/GIF.
- This app has no authentication — keep it on your trusted LAN or put it behind
  a reverse proxy / VPN if you expose it.
- Design: STACKS, a high-fidelity dark UI (Barlow Condensed / Barlow / Space Mono,
  with format-coded accents — Blu-ray blue, 4K UHD amber, Apple TV violet).
