# 🎞 STACKS — Physical Media Library

A self-hosted web app for cataloguing a physical **Blu-ray / 4K UHD** disc
collection. Built to run in Docker on a NAS with a MySQL database. Browse your
discs as a **poster wall** or a **shelf of spines**, track studio/distributor,
flag which discs are **ripped to Plex**, upload your own cover art, and enrich
each title with data pulled from [OMDB](https://www.omdbapi.com/) and stored
locally.

## Features

- Track **title, year, studio, distributor/label, format** (Blu-ray or 4K UHD)
- **Ripped to Plex** flag, toggleable inline from the detail view
- **Two views** of the collection: a poster **wall** grid and a **shelf** of
  vertical spines (color-coded by format), with a generated catalog code per disc
- **Upload cover art** — stored on a Docker volume on your NAS; falls back to the
  OMDB poster, then to a generated house-style cover when no image exists
- **OMDB search-and-pick on add**: search by title, choose the match, and details
  (director, cast, plot, genre, runtime, rating, and review scores) are fetched
  and saved locally so they don't depend on OMDB later
- Search, format filtering, and sorting (recently added / title / year)
- Detail modal with metadata, review-score row, edit, and inline-confirm delete

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

### Where data lives

By default both volumes are bind-mounted under `./data`:

| What            | Container path      | Host path (edit in `docker-compose.yml`) |
| --------------- | ------------------- | ---------------------------------------- |
| Cover images    | `/data/uploads`     | `./data/uploads`                         |
| MySQL data      | `/var/lib/mysql`    | `./data/mysql`                           |

To store these on a specific NAS share, change the left-hand side of those
volume mappings to an absolute path, e.g. `/volume1/docker/stacks/uploads:/data/uploads`.

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
| `title`, `year` | basic identity |
| `format` | `bluray` or `uhd` |
| `studio`, `distributor` | production studio + disc label |
| `ripped` | "Ripped to Plex" flag |
| `code` | auto-generated catalog code, e.g. `BD 044` / `UHD 012` |
| `image_file` | uploaded cover stored on the NAS volume |
| `poster_url` | OMDB poster reference |
| `director`, `actors` (cast), `plot`, `genre`, `runtime`, `rated` | from OMDB |
| `ratings` | JSON array of `{source, value}` review scores |
| `imdb_id`, `omdb_raw` | IMDb id + archived raw OMDB payload |

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/discs` | list all discs |
| GET | `/api/discs/:id` | one disc |
| POST | `/api/discs` | create (multipart; optional `image`) |
| PUT | `/api/discs/:id` | update (multipart; optional `image`) |
| PATCH | `/api/discs/:id/ripped` | set the ripped flag (`{ripped:bool}`) |
| DELETE | `/api/discs/:id` | delete (also removes its uploaded image) |
| GET | `/api/omdb/search?q=` | proxied OMDB title search |
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

## Notes

- The OMDB poster URL is saved as a reference; an uploaded cover takes precedence.
- Image uploads are limited to 10 MB and to JPEG/PNG/WebP/GIF.
- This app has no authentication — keep it on your trusted LAN or put it behind
  a reverse proxy / VPN if you expose it.
- Design: STACKS, a high-fidelity dark UI (Barlow Condensed / Barlow / Space Mono,
  amber + Blu-ray-blue accents).
