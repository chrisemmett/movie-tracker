# 🎬 Disc Collection Tracker

A small self-hosted web app for cataloguing a physical **Blu-ray / UHD** disc
collection. Built to run in Docker on a NAS with a MySQL database. Each title
records the basics (title, studio, distributor, format) plus a cover image you
upload, and can be enriched with data pulled from [OMDB](https://www.omdbapi.com/)
and stored locally.

## Features

- Track **title, studio, distributor, format** (Blu-ray or UHD) per disc
- **Upload a cover image** — stored on a Docker volume on your NAS, not in the DB
- **OMDB search-and-pick**: search by title, choose the right match, and the
  app fetches and saves details (year, runtime, genre, director, cast, plot,
  poster, IMDb rating, …) locally so you don't depend on OMDB later
- Search and filter your collection by text or format
- Responsive grid + detail view, edit and delete

## Stack

- Node.js + Express, server-rendered EJS views
- MySQL 8
- `multer` for image uploads to a mounted volume
- Packaged with Docker Compose (app + db)

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
volume mappings to an absolute path, e.g. `/volume1/docker/movie-tracker/uploads:/data/uploads`.

## Running locally without Docker

You need Node 18+ and a reachable MySQL instance.

```bash
npm install
cp .env.example .env   # set DB_* to point at your MySQL, set OMDB_API_KEY

# DB connection (override defaults as needed)
export DB_HOST=127.0.0.1 DB_USER=movietracker DB_PASSWORD=... DB_NAME=movietracker
export OMDB_API_KEY=yourkey
export UPLOAD_DIR=./data/uploads

npm start
```

The schema is created automatically on startup.

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

- The OMDB poster URL is saved as a reference; when you upload your own cover
  image it takes precedence in the UI.
- Image uploads are limited to 10 MB and to JPEG/PNG/WebP/GIF.
- This app has no authentication — keep it on your trusted LAN or put it behind
  a reverse proxy / VPN if you expose it.
