// Thin wrapper around the OMDB API (https://www.omdbapi.com/).
// Requires an API key in OMDB_API_KEY. Uses the global fetch available in
// Node 18+.

const BASE_URL = 'https://www.omdbapi.com/';

function apiKey() {
  const key = process.env.OMDB_API_KEY;
  if (!key) {
    const err = new Error(
      'OMDB_API_KEY is not set. Get a free key at https://www.omdbapi.com/apikey.aspx'
    );
    err.status = 503;
    throw err;
  }
  return key;
}

async function request(params) {
  const url = new URL(BASE_URL);
  url.searchParams.set('apikey', apiKey());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const err = new Error(`OMDB request failed with HTTP ${res.status}`);
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  if (data.Response === 'False') {
    const err = new Error(data.Error || 'OMDB returned no result');
    err.status = 404;
    throw err;
  }
  return data;
}

// Search by title — returns a lightweight list for the user to pick from.
async function search(query, { type = 'movie', page = 1 } = {}) {
  const data = await request({ s: query, type, page });
  return (data.Search || []).map((r) => ({
    title: r.Title,
    year: r.Year,
    imdbID: r.imdbID,
    type: r.Type,
    poster: r.Poster && r.Poster !== 'N/A' ? r.Poster : null,
  }));
}

// Normalize OMDB's verbose rating source names to short labels.
function shortSource(s) {
  if (/Rotten/i.test(s)) return 'Rotten Tomatoes';
  if (/Metacritic/i.test(s)) return 'Metacritic';
  if (/Internet/i.test(s)) return 'IMDb';
  return s;
}

// Full details for a single title by IMDb id. Returns a normalized object
// matching our DB columns plus the raw payload for archival.
async function detail(imdbID) {
  const d = await request({ i: imdbID, plot: 'full' });
  const clean = (v) => (v && v !== 'N/A' ? v : null);
  const ratings = (d.Ratings || []).map((x) => ({
    source: shortSource(x.Source),
    value: x.Value,
  }));
  return {
    imdb_id: clean(d.imdbID),
    title: clean(d.Title),
    year: clean(d.Year) ? String(d.Year).slice(0, 4) : null,
    rated: clean(d.Rated),
    released: clean(d.Released),
    runtime: clean(d.Runtime),
    genre: clean(d.Genre),
    director: clean(d.Director),
    writer: clean(d.Writer),
    actors: clean(d.Actors),
    cast: clean(d.Actors),
    studio: clean(d.Production),
    plot: clean(d.Plot),
    language: clean(d.Language),
    country: clean(d.Country),
    poster_url: clean(d.Poster),
    imdb_rating: clean(d.imdbRating),
    ratings,
    omdb_raw: d,
  };
}

module.exports = { search, detail, shortSource };
