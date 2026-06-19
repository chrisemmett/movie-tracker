/* STACKS — Physical Media Library (client).
 * Vanilla JS SPA backed by the Express + MySQL JSON API. Mirrors the design
 * prototype's behavior; persistence and OMDb lookups go through the server. */
(function () {
  'use strict';

  var state = {
    discs: [],
    view: 'wall',
    query: '',
    fmt: 'all',
    sort: 'added',
    detailId: null,
    confirmDelete: false,
    addOpen: false,
    editId: null,
    step: 'search',
    searchQuery: '',
    searching: false,
    searched: false,
    searchError: '',
    results: [],
    form: blankForm(),
    saving: false,
    imgBroken: new Set(),
  };

  var root = document.getElementById('app');

  // ---------- helpers ----------
  function blankForm() {
    return { title: '', year: '', format: 'bluray', studio: '', distributor: '', ripped: false,
      poster: '', director: '', cast: '', plot: '', genre: '', runtime: '', rated: '', ratings: [], imdbID: '' };
  }
  function fmtMeta(f) {
    return f === 'uhd'
      ? { label: '4K UHD', color: '#e7b34c', short: 'UHD' }
      : { label: 'BLU-RAY', color: '#4d8df0', short: 'BD' };
  }
  function hashHue(s) {
    var h = 0; s = s || '';
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- API ----------
  function api(path, opts) {
    return fetch(path, opts).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      var body = ct.indexOf('application/json') >= 0 ? res.json() : res.text();
      return body.then(function (data) {
        if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
        return data;
      });
    });
  }
  function loadDiscs() {
    return api('/api/discs').then(function (d) {
      state.discs = d.discs || [];
      renderHeader(); renderContent();
    });
  }

  // ---------- derived ----------
  function filteredSorted() {
    var q = state.query.trim().toLowerCase();
    var list = state.discs.filter(function (d) {
      if (state.fmt !== 'all' && d.format !== state.fmt) return false;
      if (!q) return true;
      return (d.title + ' ' + d.studio + ' ' + d.distributor + ' ' + d.director + ' ' + d.cast + ' ' + d.year)
        .toLowerCase().indexOf(q) >= 0;
    });
    return list.sort(function (a, b) {
      if (state.sort === 'title') return a.title.localeCompare(b.title);
      if (state.sort === 'year') return (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0);
      return (b.addedAt || 0) - (a.addedAt || 0);
    });
  }

  // ---------- shared bits ----------
  function houseHTML(hue, initial, code, variant) {
    var bg = variant === 'detail'
      ? 'linear-gradient(165deg, hsl(' + hue + ' 36% 18%), #0a0a0e 74%)'
      : 'linear-gradient(165deg, hsl(' + hue + ' 36% 17%), #0b0b0f 72%)';
    var col = variant === 'detail' ? 'hsl(' + hue + ' 44% 26%)' : 'hsl(' + hue + ' 42% 24%)';
    return '<div class="house" style="background:' + bg + '">' +
      '<div class="house-initial" style="color:' + col + '">' + escapeHtml(initial) + '</div>' +
      '<div class="house-code">' + escapeHtml(code) + '</div></div>';
  }
  function plexBadge() {
    return '<div class="plex-badge"><span class="tri">▶</span><span class="txt">PLEX</span></div>';
  }
  function posterOrHouse(d, variant) {
    var showPoster = d.poster && !state.imgBroken.has(d.poster);
    if (showPoster) {
      return '<img class="card-img" data-poster="' + escapeHtml(d.poster) + '" src="' + escapeHtml(d.poster) + '" alt="">';
    }
    var initial = (d.title || '?').trim().charAt(0).toUpperCase();
    return houseHTML(hashHue(d.title), initial, d.code, variant);
  }

  // ---------- header ----------
  function renderHeader() {
    var total = state.discs.length;
    var uhd = state.discs.filter(function (d) { return d.format === 'uhd'; }).length;
    var ripped = state.discs.filter(function (d) { return d.ripped; }).length;
    document.getElementById('header').innerHTML =
      '<div class="brand">' +
        '<svg width="34" height="34" viewBox="0 0 24 24" fill="none">' +
          '<circle cx="12" cy="12" r="11" stroke="#e7b34c" stroke-width="1.4"/>' +
          '<circle cx="12" cy="12" r="6.4" stroke="#e7b34c" stroke-width="0.8" opacity="0.5"/>' +
          '<circle cx="12" cy="12" r="2.6" fill="#e7b34c"/>' +
          '<circle cx="12" cy="12" r="0.9" fill="#0a0a0d"/>' +
        '</svg>' +
        '<div><div class="brand-mark">STACKS</div><div class="brand-sub">Physical Media Library</div></div>' +
      '</div>' +
      '<div class="header-right">' +
        '<div class="stats">' +
          stat(total, 'DISCS', '') +
          stat(total - uhd, 'BLU-RAY', 'bluray') +
          stat(uhd, '4K UHD', 'uhd') +
          stat(ripped, 'RIPPED', '') +
        '</div>' +
        '<button class="btn-add" data-action="open-add"><span>+</span> Add disc</button>' +
      '</div>';
  }
  function stat(num, cap, cls) {
    return '<div class="stat"><div class="stat-num ' + cls + '">' + num + '</div><div class="stat-cap">' + cap + '</div></div>';
  }

  // ---------- toolbar ----------
  function renderToolbar() {
    var seg = function (action, val, cur, label) {
      return '<button class="seg-btn' + (val === cur ? ' active' : '') + '" data-action="' + action + '" data-val="' + val + '">' + label + '</button>';
    };
    document.getElementById('toolbar').innerHTML =
      '<div class="search">' +
        '<span class="search-icon">⌕</span>' +
        '<input id="searchInput" class="search-input" placeholder="Search titles, directors, studios…" value="' + escapeHtml(state.query) + '">' +
      '</div>' +
      '<div class="toolbar-right">' +
        '<div class="segmented">' +
          seg('set-fmt', 'all', state.fmt, 'ALL') +
          seg('set-fmt', 'bluray', state.fmt, 'BLU-RAY') +
          seg('set-fmt', 'uhd', state.fmt, '4K UHD') +
        '</div>' +
        '<select id="sortSelect" class="select">' +
          opt('added', 'Recently added') + opt('title', 'Title A–Z') + opt('year', 'Year (newest)') +
        '</select>' +
        '<div class="segmented">' +
          seg('set-view', 'wall', state.view, '▦ WALL') +
          seg('set-view', 'shelf', state.view, '▥ SHELF') +
        '</div>' +
      '</div>';
  }
  function opt(val, label) {
    return '<option value="' + val + '"' + (state.sort === val ? ' selected' : '') + '>' + label + '</option>';
  }

  // ---------- content ----------
  function renderContent() {
    var cards = filteredSorted();
    var el = document.getElementById('content');
    if (cards.length === 0) { el.innerHTML = emptyHTML(); return; }
    el.innerHTML = state.view === 'wall' ? wallHTML(cards) : shelfHTML(cards);
  }
  function emptyHTML() {
    var none = state.discs.length === 0;
    return '<div class="empty"><div class="empty-glyph">◎</div>' +
      '<div class="empty-msg">' + (none ? 'Your stacks are empty.' : 'No discs match.') + '</div>' +
      '<div class="empty-sub">' + (none ? 'Add your first disc to start the collection.' : 'Try a different search or filter.') + '</div></div>';
  }
  function wallHTML(cards) {
    return '<div class="wall">' + cards.map(function (d) {
      var m = fmtMeta(d.format);
      return '<div class="card" style="--accent:' + m.color + '" data-action="open-detail" data-id="' + d.id + '">' +
        posterOrHouse(d, 'card') +
        (d.ripped ? plexBadge() : '') +
        '<div class="card-caption">' +
          '<div class="fmt-row"><span class="fmt-dot"></span><span class="fmt-label">' + m.label + '</span></div>' +
          '<div class="card-title">' + escapeHtml(d.title) + '</div>' +
          '<div class="card-year">' + escapeHtml(d.year) + '</div>' +
        '</div></div>';
    }).join('') + '</div>';
  }
  function shelfHTML(cards) {
    return '<div class="shelf"><div class="shelf-row">' + cards.map(function (d) {
      var m = fmtMeta(d.format);
      return '<div class="spine" style="--accent:' + m.color + '" title="' + escapeHtml(d.title) + '" data-action="open-detail" data-id="' + d.id + '">' +
        '<span class="spine-short">' + m.short + '</span>' +
        '<div class="spine-title">' + escapeHtml(d.title) + '</div>' +
        (d.ripped ? '<span class="spine-tri">▶</span>' : '') +
        '<span class="spine-code">' + escapeHtml(d.code) + '</span>' +
      '</div>';
    }).join('') + '</div></div>';
  }

  // ---------- modals ----------
  function renderModals() {
    var html = '';
    if (state.detailId) html += detailModalHTML();
    if (state.addOpen) html += addModalHTML();
    document.getElementById('modals').innerHTML = html;
  }

  function detailModalHTML() {
    var d = state.discs.find(function (x) { return x.id === state.detailId; });
    if (!d) return '';
    var m = fmtMeta(d.format);
    var genres = (d.genre || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    var castList = (d.cast || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    var metaLine = [d.year, d.runtime, d.rated].filter(Boolean).join('   ·   ') || '—';
    var ratings = d.ratings || [];

    var del = state.confirmDelete
      ? '<span class="confirm-text">Sure?</span>' +
        '<button class="btn-del-solid" data-action="detail-do-delete" data-id="' + d.id + '">Yes, delete</button>' +
        '<button class="btn-neutral" data-action="detail-cancel-delete">Keep</button>'
      : '<button class="btn-del-outline" data-action="detail-ask-delete">Delete</button>';

    return '<div class="overlay" data-action="overlay" data-modal="detail">' +
      '<div class="dialog">' +
        '<div class="detail-cover">' + posterOrHouse(d, 'detail') + '</div>' +
        '<div class="detail-body">' +
          '<button class="close-btn" data-action="close-detail">✕</button>' +
          '<div class="chip-row">' +
            '<span class="chip" style="--accent:' + m.color + '"><span class="chip-dot"></span><span class="chip-label">' + m.label + '</span></span>' +
            '<span class="detail-code">' + escapeHtml(d.code) + '</span>' +
          '</div>' +
          '<div class="detail-title">' + escapeHtml(d.title) + '</div>' +
          '<div class="meta-line">' + escapeHtml(metaLine) + '</div>' +
          (genres.length ? '<div class="genre-row">' + genres.map(function (g) { return '<span class="genre-chip">' + escapeHtml(g) + '</span>'; }).join('') + '</div>' : '') +
          (d.plot ? '<p class="plot">' + escapeHtml(d.plot) + '</p>' : '') +
          (ratings.length ? '<div class="ratings-row">' + ratings.map(function (r) {
            return '<div><div class="rating-val">' + escapeHtml(r.value) + '</div><div class="rating-src">' + escapeHtml(r.source) + '</div></div>';
          }).join('') + '</div>' : '') +
          '<div class="info-grid">' +
            infoCell('Director', d.director || '—') +
            infoCell('Cast', castList.slice(0, 6).join(', ') || '—') +
            infoCell('Studio', d.studio || '—') +
            infoCell('Distributor / Label', d.distributor || '—') +
          '</div>' +
          '<div class="actions-row">' +
            '<button class="rip-toggle' + (d.ripped ? ' on' : '') + '" data-action="detail-toggle-rip" data-id="' + d.id + '">' +
              '<span class="rip-dot">▶</span><span class="rip-text">' + (d.ripped ? 'Ripped to Plex' : 'Not ripped') + '</span>' +
            '</button>' +
            '<div class="actions-right">' +
              '<button class="btn-neutral" data-action="detail-edit" data-id="' + d.id + '">Edit</button>' + del +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div></div>';
  }
  function infoCell(label, val) {
    return '<div><div class="info-label">' + label + '</div><div class="info-val">' + escapeHtml(val) + '</div></div>';
  }

  function addModalHTML() {
    var title = state.editId ? 'Edit disc' : 'Add to the stacks';
    return '<div class="overlay top" data-action="overlay" data-modal="add">' +
      '<div class="dialog-add">' +
        '<div class="modal-head"><div class="modal-title">' + title + '</div>' +
          '<button class="close-btn" data-action="close-add">✕</button></div>' +
        (state.step === 'search' ? searchStepHTML() : detailsStepHTML()) +
      '</div></div>';
  }

  function searchStepHTML() {
    var body = '';
    if (state.searching) {
      body = '<div class="loading"><span class="spinner"></span> Searching OMDb…</div>';
    } else if (state.searchError) {
      body = '<div class="err-msg">' + escapeHtml(state.searchError) + '</div>';
    } else if (state.searched && state.results.length === 0) {
      body = '<div class="muted-msg">No matches found.</div>';
    } else if (state.results.length) {
      body = '<div class="results">' + state.results.map(function (r) {
        var has = r.poster;
        var thumb = has
          ? '<img class="result-thumb" src="' + escapeHtml(r.poster) + '" alt="">'
          : '<div class="result-thumb-ph">▦</div>';
        return '<button class="result-btn" data-action="pick-result" data-imdb="' + escapeHtml(r.imdbID) + '">' +
          thumb +
          '<div><div class="result-title">' + escapeHtml(r.title) + '</div>' +
          '<div class="result-year">' + escapeHtml(r.year) + '</div></div></button>';
      }).join('') + '</div>';
    }
    return '<div class="step">' +
      '<div class="search-row">' +
        '<input id="omdbSearch" class="search-field" placeholder="Search a movie title…" value="' + escapeHtml(state.searchQuery) + '">' +
        '<button class="btn-amber" data-action="run-search">Search</button>' +
      '</div>' + body +
      '<div class="skip-row"><button class="skip-link" data-action="start-manual">Skip — enter details manually</button></div>' +
    '</div>';
  }

  function detailsStepHTML() {
    var f = state.form;
    var hasMeta = !!(f.director || f.cast);
    var metaStrip = hasMeta
      ? '<div class="meta-strip">' +
          (f.poster ? '<img class="meta-thumb" src="' + escapeHtml(f.poster) + '" alt="">' : '') +
          '<div><div class="meta-cap">Pulled from OMDb</div>' +
            '<div class="meta-line2"><span class="k">Dir.</span> ' + escapeHtml(f.director || '—') + '</div>' +
            '<div class="meta-line2"><span class="k">Cast</span> ' + escapeHtml(f.cast || '—') + '</div></div>' +
        '</div>'
      : '';
    var fb = f.format === 'bluray', fu = f.format === 'uhd', fr = !!f.ripped;
    var posterNote = f.poster
      ? '<div class="meta-cap" style="margin-top:6px;">Uploading a file overrides the OMDb poster.</div>' : '';

    return '<div class="step">' + metaStrip +
      '<div class="field-grid grid-title-year">' +
        field('Title', 'title', f.title, 'Movie title') +
        field('Year', 'year', f.year, '2024') +
      '</div>' +
      '<div class="field-grid grid-2">' +
        field('Studio', 'studio', f.studio, 'e.g. Warner Bros.') +
        field('Distributor / Label', 'distributor', f.distributor, 'e.g. Criterion') +
      '</div>' +
      '<div class="fmt-rip-row">' +
        '<div><label class="field-label">Format</label><div class="fmt-opts">' +
          '<button class="fmt-opt' + (fb ? ' sel-blu' : '') + '" data-action="form-format" data-fmt="bluray"><span class="fmt-opt-dot blu"></span><span class="fmt-opt-text">Blu-ray</span></button>' +
          '<button class="fmt-opt' + (fu ? ' sel-uhd' : '') + '" data-action="form-format" data-fmt="uhd"><span class="fmt-opt-dot uhd"></span><span class="fmt-opt-text">4K UHD</span></button>' +
        '</div></div>' +
        '<div><label class="field-label">Ripped to Plex</label>' +
          '<button class="rip-pill' + (fr ? ' on' : '') + '" data-action="form-ripped">' +
            '<span class="rip-dot">▶</span><span class="rip-text">' + (fr ? 'Yes — in Plex' : 'Not ripped') + '</span>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="upload-row"><label class="field-label">Cover image (optional, stored on your NAS)</label>' +
        '<input id="formImage" class="file-input" type="file" accept="image/*">' + posterNote +
      '</div>' +
      '<div class="footer-row">' +
        (state.editId ? '<span></span>' : '<button class="back-link" data-action="back-to-search">← Back to search</button>') +
        '<button class="btn-save" data-action="save-form"' + (state.saving ? ' disabled' : '') + '>' +
          (state.saving ? 'Saving…' : (state.editId ? 'Save changes' : 'Add disc')) + '</button>' +
      '</div>' +
    '</div>';
  }
  function field(label, name, val, ph) {
    return '<div><label class="field-label">' + label + '</label>' +
      '<input class="input" data-field="' + name + '" value="' + escapeHtml(val) + '" placeholder="' + escapeHtml(ph) + '"></div>';
  }

  // ---------- read form fields from DOM (uncontrolled inputs) ----------
  function syncFormFromDom() {
    document.querySelectorAll('#modals [data-field]').forEach(function (el) {
      state.form[el.dataset.field] = el.value;
    });
  }

  // ---------- actions ----------
  function openDetail(id) { state.detailId = id; state.confirmDelete = false; renderModals(); }
  function closeDetail() { state.detailId = null; state.confirmDelete = false; renderModals(); }
  function openAdd() {
    state.addOpen = true; state.editId = null; state.step = 'search';
    state.form = blankForm(); state.results = []; state.searchQuery = '';
    state.searched = false; state.searchError = ''; renderModals();
  }
  function closeAdd() { state.addOpen = false; state.editId = null; renderModals(); }

  function runSearch() {
    var input = document.getElementById('omdbSearch');
    state.searchQuery = input ? input.value : state.searchQuery;
    var q = state.searchQuery.trim();
    if (!q) return;
    state.searching = true; state.searchError = ''; state.searched = true; state.results = [];
    renderModals();
    api('/api/omdb/search?q=' + encodeURIComponent(q)).then(function (data) {
      state.results = (data.results || []).map(function (r) {
        return { imdbID: r.imdbID, title: r.title, year: r.year, poster: r.poster || '' };
      });
      state.searching = false; renderModals();
    }).catch(function (err) {
      state.searching = false;
      state.searchError = err.message + ' — or add this disc manually below.';
      renderModals();
    });
  }

  function pickResult(imdbID) {
    var r = state.results.find(function (x) { return x.imdbID === imdbID; });
    state.searching = true; renderModals();
    api('/api/omdb/detail/' + encodeURIComponent(imdbID)).then(function (d) {
      state.form = {
        title: d.title || (r && r.title) || '', year: (d.year || (r && r.year) || '').slice(0, 4),
        format: state.form.format, studio: '', distributor: '', ripped: false,
        poster: d.poster_url || '', director: d.director || '', cast: d.cast || d.actors || '',
        plot: d.plot || '', genre: d.genre || '', runtime: d.runtime || '', rated: d.rated || '',
        ratings: d.ratings || [], imdbID: d.imdb_id || imdbID,
      };
      state.searching = false; state.step = 'details'; renderModals();
    }).catch(function () {
      if (r) { state.form.title = r.title; state.form.year = (r.year || '').slice(0, 4); state.form.poster = r.poster || ''; }
      state.searching = false; state.step = 'details'; renderModals();
    });
  }

  function editDisc(id) {
    var d = state.discs.find(function (x) { return x.id === id; });
    if (!d) return;
    state.addOpen = true; state.editId = id; state.step = 'details'; state.detailId = null;
    state.form = {
      title: d.title, year: d.year, format: d.format, studio: d.studio, distributor: d.distributor,
      ripped: d.ripped, poster: d.hasUpload ? '' : d.poster, director: d.director, cast: d.cast,
      plot: d.plot, genre: d.genre, runtime: d.runtime, rated: d.rated, ratings: d.ratings || [], imdbID: d.imdbID,
    };
    renderModals();
  }

  function saveForm() {
    syncFormFromDom();
    var f = state.form;
    if (!f.title || !f.title.trim()) return;
    state.saving = true; renderModals();

    var fd = new FormData();
    ['title', 'year', 'format', 'studio', 'distributor', 'director', 'cast', 'plot', 'genre', 'runtime', 'rated', 'imdbID']
      .forEach(function (k) { fd.append(k, f[k] || ''); });
    fd.append('ripped', f.ripped ? 'true' : 'false');
    fd.append('poster', f.poster || '');
    fd.append('ratings', JSON.stringify(f.ratings || []));
    var fileEl = document.getElementById('formImage');
    if (fileEl && fileEl.files && fileEl.files[0]) fd.append('image', fileEl.files[0]);

    var url = state.editId ? '/api/discs/' + state.editId : '/api/discs';
    api(url, { method: state.editId ? 'PUT' : 'POST', body: fd }).then(function () {
      state.saving = false; state.addOpen = false; state.editId = null;
      return loadDiscs();
    }).then(renderModals).catch(function (err) {
      state.saving = false; renderModals();
      alert('Could not save: ' + err.message);
    });
  }

  function toggleRipped(id) {
    var d = state.discs.find(function (x) { return x.id === id; });
    if (!d) return;
    api('/api/discs/' + id + '/ripped', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ripped: !d.ripped }),
    }).then(function (updated) {
      var i = state.discs.findIndex(function (x) { return x.id === id; });
      if (i >= 0) state.discs[i] = updated;
      renderHeader(); renderContent(); renderModals();
    }).catch(function (err) { alert('Could not update: ' + err.message); });
  }

  function deleteDisc(id) {
    api('/api/discs/' + id, { method: 'DELETE' }).then(function () {
      state.detailId = null; state.confirmDelete = false;
      return loadDiscs();
    }).then(renderModals).catch(function (err) { alert('Could not delete: ' + err.message); });
  }

  // ---------- event wiring ----------
  function onClick(e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var action = el.dataset.action;

    if (action === 'overlay') {
      if (e.target === el) { if (el.dataset.modal === 'detail') closeDetail(); else closeAdd(); }
      return;
    }
    switch (action) {
      case 'open-add': return openAdd();
      case 'set-fmt': state.fmt = el.dataset.val; renderToolbar(); renderContent(); return;
      case 'set-view': state.view = el.dataset.val; renderToolbar(); renderContent(); return;
      case 'open-detail': return openDetail(el.dataset.id);
      case 'close-detail': return closeDetail();
      case 'close-add': return closeAdd();
      case 'detail-toggle-rip': return toggleRipped(el.dataset.id);
      case 'detail-edit': return editDisc(el.dataset.id);
      case 'detail-ask-delete': state.confirmDelete = true; return renderModals();
      case 'detail-cancel-delete': state.confirmDelete = false; return renderModals();
      case 'detail-do-delete': return deleteDisc(el.dataset.id);
      case 'run-search': return runSearch();
      case 'start-manual': syncFormFromDom(); state.step = 'details'; return renderModals();
      case 'back-to-search': state.step = 'search'; return renderModals();
      case 'pick-result': return pickResult(el.dataset.imdb);
      case 'form-format': syncFormFromDom(); state.form.format = el.dataset.fmt; return renderModals();
      case 'form-ripped': syncFormFromDom(); state.form.ripped = !state.form.ripped; return renderModals();
      case 'save-form': return saveForm();
    }
  }

  function onInput(e) {
    if (e.target.id === 'searchInput') { state.query = e.target.value; renderContent(); }
  }
  function onChange(e) {
    if (e.target.id === 'sortSelect') { state.sort = e.target.value; renderContent(); }
  }
  function onKeydown(e) {
    if (e.key === 'Escape') {
      if (state.addOpen) { closeAdd(); }
      else if (state.detailId) { closeDetail(); }
    } else if (e.key === 'Enter' && e.target.id === 'omdbSearch') {
      e.preventDefault(); runSearch();
    }
  }
  // Mark posters that fail to load so they flip to the house-style cover.
  function onError(e) {
    var t = e.target;
    if (t && t.dataset && t.dataset.poster && !state.imgBroken.has(t.dataset.poster)) {
      state.imgBroken.add(t.dataset.poster);
      renderContent(); renderModals();
    }
  }

  // ---------- init ----------
  root.innerHTML =
    '<div id="header" class="header"></div>' +
    '<div id="toolbar" class="toolbar"></div>' +
    '<div id="content" class="wrap"></div>' +
    '<div id="modals"></div>';

  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('error', onError, true);
  document.addEventListener('keydown', onKeydown);

  renderHeader();
  renderToolbar();
  document.getElementById('content').innerHTML = '<div class="empty"><div class="empty-glyph">◎</div><div class="empty-msg">Loading…</div></div>';
  loadDiscs().catch(function (err) {
    document.getElementById('content').innerHTML = '<div class="empty"><div class="empty-glyph">◎</div><div class="empty-msg">Could not load your collection.</div><div class="empty-sub">' + escapeHtml(err.message) + '</div></div>';
  });
})();
