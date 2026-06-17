// OMDB search-and-pick for the add/edit form. Searches OMDB, lets the user
// choose a match, then fetches full details and fills the form fields.
(function () {
  const $ = (id) => document.getElementById(id);

  const queryEl = $('omdb-query');
  const searchBtn = $('omdb-search-btn');
  const statusEl = $('omdb-status');
  const resultsEl = $('omdb-results');

  // Map of OMDB detail fields -> form input ids.
  const FIELD_MAP = {
    title: 'title', year: 'year', rated: 'rated', runtime: 'runtime',
    genre: 'genre', director: 'director', writer: 'writer', actors: 'actors',
    released: 'released', language: 'language', country: 'country',
    imdb_rating: 'imdb_rating', imdb_id: 'imdb_id', plot: 'plot',
  };

  async function runSearch() {
    const q = queryEl.value.trim();
    if (!q) return;
    statusEl.textContent = 'Searching…';
    resultsEl.innerHTML = '';
    try {
      const res = await fetch('/api/omdb/search?q=' + encodeURIComponent(q));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Search failed');
      if (!data.results.length) {
        statusEl.textContent = 'No matches found.';
        return;
      }
      statusEl.textContent = '';
      data.results.forEach(renderResult);
    } catch (err) {
      statusEl.textContent = err.message;
    }
  }

  function renderResult(r) {
    const li = document.createElement('li');
    li.className = 'omdb-result';
    li.innerHTML =
      (r.poster ? `<img src="${r.poster}" alt="">` : '<div class="poster placeholder small">N/A</div>') +
      `<div class="omdb-result-meta"><strong>${escapeHtml(r.title)}</strong>` +
      `<span class="muted">${escapeHtml(r.year || '')} · ${escapeHtml(r.type || '')}</span></div>` +
      '<button type="button" class="btn btn-sm">Use this</button>';
    li.querySelector('button').addEventListener('click', () => choose(r.imdbID, li));
    resultsEl.appendChild(li);
  }

  async function choose(imdbID, li) {
    const btn = li.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
      const res = await fetch('/api/omdb/detail/' + encodeURIComponent(imdbID));
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Lookup failed');
      fillForm(d);
      statusEl.textContent = 'Filled from OMDB — review and save.';
      resultsEl.innerHTML = '';
      window.scrollTo({ top: document.querySelector('.movie-form').offsetTop - 20, behavior: 'smooth' });
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Use this';
      statusEl.textContent = err.message;
    }
  }

  function fillForm(d) {
    Object.entries(FIELD_MAP).forEach(([key, id]) => {
      const el = $(id);
      if (el && d[key]) el.value = d[key];
    });
    $('poster_url').value = d.poster_url || '';
    $('omdb_raw').value = d.omdb_raw ? JSON.stringify(d.omdb_raw) : '';

    const preview = $('omdb-poster-preview');
    if (d.poster_url) {
      $('omdb-poster-img').src = d.poster_url;
      preview.hidden = false;
    } else {
      preview.hidden = true;
    }

    const details = document.querySelector('.enrichment');
    if (details) details.open = true;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  if (searchBtn) searchBtn.addEventListener('click', runSearch);
  if (queryEl) {
    queryEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
    });
  }
})();
