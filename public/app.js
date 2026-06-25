/* STACKS — Media Library (client).
 * Vanilla JS SPA backed by the Express + MySQL JSON API. Mirrors the design
 * prototype's behavior; persistence and OMDb lookups go through the server. */
(function () {
  'use strict';

  var state = {
    discs: [],
    view: 'wall',
    query: '',
    fmt: 'all',
    settings: {},
    sort: 'title',
    plex: 'all',
    detailId: null,
    confirmDelete: false,
    addOpen: false,
    editId: null,
    step: 'search',
    searchQuery: '',
    searchYear: '',
    searchType: 'movie',
    searching: false,
    searched: false,
    searchError: '',
    tooMany: false,
    results: [],
    totalResults: 0,
    form: blankForm(),
    saving: false,
    duplicateWarning: null,
    imgBroken: new Set(),
    menuOpen: false,
    selected: {},
    multiForm: { formats: ['bluray'], ripped: false },
    multiSaving: false,
    multiDone: 0,
    settingsOpen: false,
    recalc: { running: false, result: null, error: '' },
  };

  var root = document.getElementById('app');

  // ---------- helpers ----------
  function blankForm() {
    return { title: '', sortTitle: '', year: '', formats: ['bluray'], studio: '', distributor: '', ripped: false,
      poster: '', director: '', cast: '', plot: '', genre: '', runtime: '', rated: '', ratings: [], imdbRating: '', imdbID: '' };
  }
  var FMT_META = {
    bluray:  { label: 'BLU-RAY', color: '#4d8df0', short: 'BD' },
    uhd:     { label: '4K UHD',  color: '#e7b34c', short: 'UHD' },
    appletv: { label: 'APPLE TV', color: '#a78bfa', short: 'ATV' },
  };
  // Title-sort options. 'title' sorts on the real title (ignoring any custom
  // sort title); 'title-custom' honours each disc's custom sort title.
  var SORT_OPTIONS = [
    { val: 'added', label: 'Recently added' },
    { val: 'title', label: 'Title A–Z' },
    { val: 'title-custom', label: 'Title A–Z (Custom)' },
    { val: 'year', label: 'Year (newest)' },
  ];
  function isValidSort(v) { return SORT_OPTIONS.some(function (o) { return o.val === v; }); }

  // ---------- settings (persisted per browser via localStorage) ----------
  // Session-level user preferences live here so the app can remember choices
  // like the active sort across reloads. Add new keys to DEFAULT_SETTINGS.
  var SETTINGS_KEY = 'stacks.settings';
  var DEFAULT_SETTINGS = { sort: 'title', addFormats: ['bluray'] };
  function loadSettings() {
    var saved = {};
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) { var parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object') saved = parsed; }
    } catch (e) { /* private mode / corrupt value — fall back to defaults */ }
    var s = Object.assign({}, DEFAULT_SETTINGS, saved);
    if (!isValidSort(s.sort)) s.sort = DEFAULT_SETTINGS.sort;
    s.addFormats = Array.isArray(s.addFormats) ? s.addFormats.filter(function (f) { return FMT_META[f]; }) : [];
    if (!s.addFormats.length) s.addFormats = DEFAULT_SETTINGS.addFormats.slice();
    return s;
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); }
    catch (e) { /* ignore quota / disabled storage */ }
  }
  // The format selection to pre-fill when adding a new title — the last one the
  // user saved with, so adding a run of same-format discs needs no re-picking.
  function rememberedFormats() {
    var f = state.settings.addFormats;
    return (Array.isArray(f) && f.length) ? f.slice() : ['bluray'];
  }
  function rememberFormats(formats) {
    if (Array.isArray(formats) && formats.length) {
      state.settings.addFormats = formats.filter(function (f) { return FMT_META[f]; });
      if (!state.settings.addFormats.length) state.settings.addFormats = ['bluray'];
      saveSettings();
    }
  }
  function fmtMeta(f) { return FMT_META[f] || FMT_META.bluray; }
  function discFormats(d) {
    if (d && Array.isArray(d.formats) && d.formats.length) return d.formats;
    return [d && d.format ? d.format : 'bluray'];
  }
  function primaryFormat(d) { return discFormats(d)[0]; }
  // Apple TV titles are digital-only and can't be ripped to Plex, so they're
  // excluded from Plex-status stats. A disc is rippable if it's held in at
  // least one physical format.
  function isRippable(d) {
    return discFormats(d).some(function (f) { return f !== 'appletv'; });
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
        if (!res.ok) {
          var err = new Error((data && data.error) || ('HTTP ' + res.status));
          err.status = res.status;
          if (data) {
            if (data.code) err.code = data.code;
            err.data = data;
          }
          throw err;
        }
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
      if (state.fmt !== 'all' && discFormats(d).indexOf(state.fmt) < 0) return false;
      if (state.plex === 'plex' && !d.ripped) return false;
      if (state.plex === 'not-plex' && d.ripped) return false;
      if (!q) return true;
      return (d.title + ' ' + d.studio + ' ' + d.distributor + ' ' + d.director + ' ' + d.cast + ' ' + d.year + ' ' + (d.genre || ''))
        .toLowerCase().indexOf(q) >= 0;
    });
    return list.sort(function (a, b) {
      if (state.sort === 'title') return realTitle(a).localeCompare(realTitle(b), undefined, { numeric: true, sensitivity: 'base' });
      if (state.sort === 'title-custom') return sortableTitle(a).localeCompare(sortableTitle(b), undefined, { numeric: true, sensitivity: 'base' });
      if (state.sort === 'year') return (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0);
      return (b.addedAt || 0) - (a.addedAt || 0);
    });
  }

  // The disc's real title with a leading article ("The ", "A ", "An ")
  // stripped — ignores any custom sort title. Used by the plain
  // "Title A–Z" sort.
  function realTitle(d) {
    return (d && d.title ? d.title : '').replace(/^(the|an?)\s+/i, '').trim();
  }
  // A disc sorts by its custom sort title when set (e.g. "Matrix 2" for
  // "The Matrix Reloaded"), otherwise the real title. Used by the
  // "Title A–Z (Custom)" sort.
  function sortableTitle(d) {
    var custom = d && d.sortTitle ? d.sortTitle.trim() : '';
    if (custom) return custom;
    return realTitle(d);
  }
  // The title used for the active sort's grouping/letter index. The custom
  // sort honours sort titles; every other (alphabetical) sort uses the real
  // title.
  function sortKeyTitle(d) {
    return state.sort === 'title-custom' ? sortableTitle(d) : realTitle(d);
  }

  // ---------- shared bits ----------
  function houseHTML(hue, initial, variant) {
    var bg = variant === 'detail'
      ? 'linear-gradient(165deg, hsl(' + hue + ' 36% 18%), #0a0a0e 74%)'
      : 'linear-gradient(165deg, hsl(' + hue + ' 36% 17%), #0b0b0f 72%)';
    var col = variant === 'detail' ? 'hsl(' + hue + ' 44% 26%)' : 'hsl(' + hue + ' 42% 24%)';
    return '<div class="house" style="background:' + bg + '">' +
      '<div class="house-initial" style="color:' + col + '">' + escapeHtml(initial) + '</div>' +
      '</div>';
  }
  function plexBadge() {
    return '<span class="plex-badge"><span class="tri">▶</span><span class="txt">PLEX</span></span>';
  }
  function posterOrHouse(d, variant) {
    var showPoster = d.poster && !state.imgBroken.has(d.poster);
    if (showPoster) {
      // Lazy + async decode so a 2000-card wall doesn't fetch/decode every
      // poster up front; off-screen cards load as they scroll into view.
      return '<img class="card-img" loading="lazy" decoding="async" data-poster="' + escapeHtml(d.poster) + '" src="' + escapeHtml(d.poster) + '" alt="">';
    }
    var initial = (d.title || '?').trim().charAt(0).toUpperCase();
    return houseHTML(hashHue(d.title), initial, variant);
  }

  // ---------- header ----------
  function countWithFormat(f) {
    return state.discs.filter(function (d) { return discFormats(d).indexOf(f) >= 0; }).length;
  }
  function renderHeader() {
    var total = state.discs.length;
    var bluray = countWithFormat('bluray');
    var uhd = countWithFormat('uhd');
    var appletv = countWithFormat('appletv');
    var ripped = state.discs.filter(function (d) { return d.ripped; }).length;
    document.getElementById('header').innerHTML =
      '<div class="brand">' +
        '<svg width="34" height="34" viewBox="0 0 24 24" fill="none">' +
          '<circle cx="12" cy="12" r="11" stroke="#e7b34c" stroke-width="1.4"/>' +
          '<circle cx="12" cy="12" r="6.4" stroke="#e7b34c" stroke-width="0.8" opacity="0.5"/>' +
          '<circle cx="12" cy="12" r="2.6" fill="#e7b34c"/>' +
          '<circle cx="12" cy="12" r="0.9" fill="#0a0a0d"/>' +
        '</svg>' +
        '<div><div class="brand-mark">STACKS</div><div class="brand-sub">Media Library</div></div>' +
      '</div>' +
      '<div class="stats">' +
        stat(total, 'TITLES', '') +
        stat(bluray, 'BLU-RAY', 'bluray') +
        stat(uhd, '4K UHD', 'uhd') +
        stat(appletv, 'APPLE TV', 'appletv') +
        stat(ripped, 'RIPPED', '') +
      '</div>' +
      '<button class="btn-add" data-action="open-add"><span>+</span> Add disc</button>' +
      '<button class="btn-cog" data-action="open-settings" title="Settings" aria-label="Settings">⚙</button>';
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
      '<button class="menu-toggle' + (state.menuOpen ? ' open' : '') + '" data-action="toggle-menu" aria-expanded="' + (state.menuOpen ? 'true' : 'false') + '" aria-label="Filters and view options">' +
        '<span class="menu-icon">☰</span><span class="menu-label">Menu</span>' +
      '</button>' +
      '<div class="toolbar-right' + (state.menuOpen ? ' open' : '') + '">' +
        '<div class="segmented">' +
          seg('set-fmt', 'all', state.fmt, 'ALL') +
          seg('set-fmt', 'bluray', state.fmt, 'BLU-RAY') +
          seg('set-fmt', 'uhd', state.fmt, '4K UHD') +
          seg('set-fmt', 'appletv', state.fmt, 'APPLE TV') +
        '</div>' +
        '<div class="segmented">' +
          seg('set-plex', 'all', state.plex, 'ALL') +
          seg('set-plex', 'plex', state.plex, '▶ PLEX') +
          seg('set-plex', 'not-plex', state.plex, 'NOT PLEX') +
        '</div>' +
        '<select id="sortSelect" class="select">' +
          SORT_OPTIONS.map(function (o) { return opt(o.val, o.label); }).join('') +
        '</select>' +
        '<div class="segmented">' +
          seg('set-view', 'wall', state.view, '▦ WALL') +
          seg('set-view', 'shelf', state.view, '▥ SHELF') +
          seg('set-view', 'stats', state.view, '▧ STATS') +
        '</div>' +
      '</div>';
  }
  function opt(val, label) {
    return '<option value="' + val + '"' + (state.sort === val ? ' selected' : '') + '>' + label + '</option>';
  }

  // ---------- content ----------
  function renderContent() {
    var el = document.getElementById('content');
    if (state.view === 'stats') { el.innerHTML = statsHTML(); animateStats(); return; }
    var cards = filteredSorted();
    if (cards.length === 0) { el.innerHTML = emptyHTML(); return; }
    el.innerHTML = state.view === 'wall' ? wallHTML(cards) : shelfHTML(cards);
  }
  function emptyHTML() {
    var none = state.discs.length === 0;
    return '<div class="empty"><div class="empty-glyph">◎</div>' +
      '<div class="empty-msg">' + (none ? 'Your stacks are empty.' : 'No discs match.') + '</div>' +
      '<div class="empty-sub">' + (none ? 'Add your first disc to start the collection.' : 'Try a different search or filter.') + '</div></div>';
  }
  function formatChips(d) {
    var fmts = discFormats(d);
    // Use the short code when a title carries multiple formats so the row
    // doesn't overflow the card's narrow caption.
    var useShort = fmts.length > 1;
    return fmts.map(function (f) {
      var fm = fmtMeta(f);
      return '<span class="fmt-chip" style="--accent:' + fm.color + '">' +
        '<span class="fmt-dot"></span><span class="fmt-label">' + (useShort ? fm.short : fm.label) + '</span></span>';
    }).join('');
  }
  // First letter of a disc's active-sort title, used by the wall's A–Z index.
  // Non-letters (numerics like "2001") bucket into "#".
  function wallLetter(d) {
    var ch = (sortKeyTitle(d) || '').charAt(0).toUpperCase();
    if (ch >= 'A' && ch <= 'Z') return ch;
    if (ch >= '0' && ch <= '9') return '#';
    return '';
  }
  function azIndexHTML(cards) {
    var present = {};
    cards.forEach(function (d) { var L = wallLetter(d); if (L) present[L] = true; });
    var letters = ['#'];
    for (var i = 65; i <= 90; i++) letters.push(String.fromCharCode(i));
    return '<nav class="az-index" aria-label="Jump to letter">' + letters.map(function (L) {
      var on = !!present[L];
      return on
        ? '<button class="az-letter" data-action="az-jump" data-letter="' + L + '">' + L + '</button>'
        : '<span class="az-letter off" aria-disabled="true">' + L + '</span>';
    }).join('') + '</nav>';
  }
  function wallHTML(cards) {
    // A–Z jump list is only meaningful when the wall is alphabetically
    // sorted; under year / recently-added the first letters would jump around.
    var showAz = state.sort === 'title' || state.sort === 'title-custom';
    var inner = '<div class="wall">' + cards.map(function (d) {
      var m = fmtMeta(primaryFormat(d));
      return '<div class="card" style="--accent:' + m.color + '" data-action="open-detail" data-id="' + d.id + '" data-letter="' + wallLetter(d) + '">' +
        posterOrHouse(d, 'card') +
        '<div class="card-caption">' +
          '<div class="fmt-row">' +
            formatChips(d) +
          '</div>' +
          '<div class="card-title">' + escapeHtml(d.title) + '</div>' +
          '<div class="card-meta-row">' +
            '<div class="card-year">' + escapeHtml(d.year) + '</div>' +
            (d.ripped ? plexBadge() : '') +
          '</div>' +
        '</div></div>';
    }).join('') + '</div>';
    return showAz ? '<div class="wall-wrap">' + inner + azIndexHTML(cards) + '</div>' : inner;
  }
  function shelfHTML(cards) {
    return '<div class="shelf"><div class="shelf-row">' + cards.map(function (d) {
      var m = fmtMeta(primaryFormat(d));
      return '<div class="spine" style="--accent:' + m.color + '" title="' + escapeHtml(d.title) + '" data-action="open-detail" data-id="' + d.id + '">' +
        '<div class="spine-title">' + escapeHtml(d.title) + '</div>' +
        (d.ripped ? '<span class="spine-tri">▶</span>' : '') +
      '</div>';
    }).join('') + '</div></div>';
  }

  // ---------- stats ----------
  function parseRuntimeMinutes(s) {
    var m = /(\d+)\s*min/i.exec(s || '');
    return m ? parseInt(m[1], 10) : 0;
  }
  function parseImdbRating(ratings) {
    if (!Array.isArray(ratings)) return 0;
    for (var i = 0; i < ratings.length; i++) {
      var r = ratings[i];
      if (/imdb/i.test(r.source || '')) {
        var m = /([\d.]+)/.exec(r.value || '');
        if (m) return parseFloat(m[1]);
      }
    }
    return 0;
  }
  // The IMDb score for a disc. OMDB exposes the score in two places and they
  // don't always agree on coverage: the dedicated `imdbRating` field is present
  // for far more titles than the `Ratings` array (which is often empty for
  // less-mainstream releases). Prefer the dedicated field, fall back to the
  // array — otherwise those titles silently drop out of the average.
  function discImdbScore(d) {
    var n = parseFloat(d.imdbRating);
    if (n > 0) return n;
    return parseImdbRating(d.ratings);
  }
  function tallyTop(items, limit) {
    var counts = {};
    items.forEach(function (k) {
      if (!k) return;
      counts[k] = (counts[k] || 0) + 1;
    });
    var arr = Object.keys(counts).map(function (k) { return { key: k, count: counts[k] }; });
    arr.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return a.key.localeCompare(b.key);
    });
    return limit ? arr.slice(0, limit) : arr;
  }

  // Pick the disc that maximises `score(d)` among those with a positive score.
  // Used by the highlights row (top rated, longest, oldest, newest).
  function pickExtreme(discs, score) {
    var best = null, bestVal = -Infinity;
    discs.forEach(function (d) {
      var v = score(d);
      if (v > 0 && v > bestVal) { bestVal = v; best = d; }
    });
    return best ? { disc: best, value: bestVal } : null;
  }
  function discYear(d) { return parseInt(d.year, 10) || 0; }
  function fmtThousands(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // Accent + format tokens. Accent values mirror the design's Amber ramp;
  // format colors stay aligned with the rest of the app (chips, badges).
  var STATS_ACCENT = { solid: '#e7b34c', bright: '#f2c95f', deep: '#c8922e', hue: 82 };
  var STATS_ACCENT_VMETER = 'linear-gradient(180deg,' + STATS_ACCENT.bright + ',' + STATS_ACCENT.deep + ')';
  var STATS_ACCENT_HMETER = 'linear-gradient(90deg,' + STATS_ACCENT.deep + ',' + STATS_ACCENT.bright + ')';
  var STATS_FMT_COLOR = { bluray: '#4d8df0', uhd: '#e7b34c', appletv: '#a78bfa' };

  // Catmull-Rom-style smoothing → SVG path string for the timeline area chart.
  // Tension 0.16 matches the design prototype's curve shape (loose enough to
  // round the peaks without overshooting decade neighbours).
  function smoothPath(pts) {
    if (!pts.length) return '';
    var d = 'M ' + pts[0].x.toFixed(2) + ' ' + pts[0].y.toFixed(2);
    var t = 0.16;
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i];
      var p1 = pts[i];
      var p2 = pts[i + 1];
      var p3 = pts[i + 2] || p2;
      var c1x = p1.x + (p2.x - p0.x) * t;
      var c1y = p1.y + (p2.y - p0.y) * t;
      var c2x = p2.x - (p3.x - p1.x) * t;
      var c2y = p2.y - (p3.y - p1.y) * t;
      d += ' C ' + c1x.toFixed(2) + ' ' + c1y.toFixed(2) +
           ', ' + c2x.toFixed(2) + ' ' + c2y.toFixed(2) +
           ', ' + p2.x.toFixed(2) + ' ' + p2.y.toFixed(2);
    }
    return d;
  }

  // Squarified treemap (Bruls et al.) — packs `items` (each `{name, value}`)
  // into rects of `{x,y,w,h,name,value}` filling the `w × h` box. Ported from
  // the prototype's geometry helper.
  function squarify(items, x, y, w, h) {
    var data = items.slice().sort(function (a, b) { return b.value - a.value; });
    var total = data.reduce(function (s, d) { return s + d.value; }, 0);
    if (!total) return [];
    var scale = (w * h) / total;
    var nodes = data.map(function (d) {
      return { name: d.name, value: d.value, area: d.value * scale };
    });
    var result = [];
    var rect = { x: x, y: y, w: w, h: h };
    function worst(r, side) {
      var s = 0, mx = 0, mn = Infinity;
      for (var k = 0; k < r.length; k++) {
        var nd = r[k];
        s += nd.area;
        if (nd.area > mx) mx = nd.area;
        if (nd.area < mn) mn = nd.area;
      }
      return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
    }
    function layout(r) {
      var s = r.reduce(function (a, nd) { return a + nd.area; }, 0);
      var k;
      if (rect.w >= rect.h) {
        var cw = s / rect.h, cy = rect.y;
        for (k = 0; k < r.length; k++) {
          var ch = r[k].area / cw;
          result.push({ name: r[k].name, value: r[k].value, x: rect.x, y: cy, w: cw, h: ch });
          cy += ch;
        }
        rect.x += cw; rect.w -= cw;
      } else {
        var ch2 = s / rect.w, cx = rect.x;
        for (k = 0; k < r.length; k++) {
          var cw2 = r[k].area / ch2;
          result.push({ name: r[k].name, value: r[k].value, x: cx, y: rect.y, w: cw2, h: ch2 });
          cx += cw2;
        }
        rect.y += ch2; rect.h -= ch2;
      }
    }
    var row = [];
    var queue = nodes.slice();
    while (queue.length) {
      var nd = queue[0];
      var side = Math.min(rect.w, rect.h);
      if (row.length === 0 || worst(row.concat([nd]), side) <= worst(row, side)) {
        row.push(nd); queue.shift();
      } else {
        layout(row); row = [];
      }
    }
    if (row.length) layout(row);
    return result;
  }

  // Map an IMDb score to a 0–100% position on the 5-bucket histogram x-axis
  // (`<6, 6, 7, 8, 9+`). Each bucket occupies 20% of the track; the score
  // lands proportionally inside its bucket.
  function ratingPositionPct(score) {
    var s = score;
    var idx, frac;
    if (s < 6) { idx = 0; frac = Math.max(0, (s - 5)); }
    else if (s < 7) { idx = 1; frac = s - 6; }
    else if (s < 8) { idx = 2; frac = s - 7; }
    else if (s < 9) { idx = 3; frac = s - 8; }
    else { idx = 4; frac = Math.min(1, s - 9); }
    return ((idx + frac) / 5) * 100;
  }

  function statsHTML() {
    var discs = state.discs;
    if (!discs.length) return emptyHTML();

    var total = discs.length;
    var bluray = countWithFormat('bluray');
    var uhd = countWithFormat('uhd');
    var appletv = countWithFormat('appletv');
    // The total disc/file count sums each title's format chips, so a title
    // owned in two formats counts twice. Used as the donut center label and
    // the hero strip's "discs & files" subline.
    var formatSum = bluray + uhd + appletv;

    // Plex-status figures only count rippable (non Apple TV-only) titles.
    var rippableTotal = discs.filter(isRippable).length;
    var ripped = discs.filter(function (d) { return d.ripped && isRippable(d); }).length;
    var notRipped = rippableTotal - ripped;
    var rippedPct = rippableTotal ? Math.round((ripped / rippableTotal) * 100) : 0;

    var totalRuntime = discs.reduce(function (s, d) { return s + parseRuntimeMinutes(d.runtime); }, 0);
    var runtimeDays = (totalRuntime / 60 / 24).toFixed(1);

    var imdbScores = discs.map(function (d) { return discImdbScore(d); }).filter(function (n) { return n > 0; });
    var avgImdbN = imdbScores.length
      ? imdbScores.reduce(function (s, n) { return s + n; }, 0) / imdbScores.length
      : 0;
    var avgImdb = imdbScores.length ? avgImdbN.toFixed(1) : '—';

    // Highlights
    var topRated = pickExtreme(discs, discImdbScore);
    var longest = pickExtreme(discs, function (d) { return parseRuntimeMinutes(d.runtime); });
    var newest = pickExtreme(discs, discYear);
    var oldest = pickExtreme(discs, function (d) { var y = discYear(d); return y > 0 ? (10000 - y) : 0; });
    var minYear = oldest ? discYear(oldest.disc) : 0;
    var maxYear = newest ? discYear(newest.disc) : 0;
    var yearSpan = (minYear && maxYear) ? (maxYear - minYear + 1) : 0;

    // Decades — pad missing decades with zero counts so the timeline reads
    // continuously rather than skipping eras.
    var decadeCounts = {};
    discs.forEach(function (d) {
      var y = parseInt(d.year, 10);
      if (!y) return;
      var k = Math.floor(y / 10) * 10;
      decadeCounts[k] = (decadeCounts[k] || 0) + 1;
    });
    var decadeKeys = Object.keys(decadeCounts).map(Number);
    var decades = [];
    if (decadeKeys.length) {
      var minD = Math.min.apply(null, decadeKeys);
      var maxD = Math.max.apply(null, decadeKeys);
      for (var dec = minD; dec <= maxD; dec += 10) {
        decades.push({ decade: dec, label: "'" + String(dec % 100).padStart(2, '0') + 's', count: decadeCounts[dec] || 0 });
      }
    }

    // Genres
    var allGenres = [];
    discs.forEach(function (d) {
      (d.genre || '').split(',').forEach(function (g) {
        g = g.trim(); if (g) allGenres.push(g);
      });
    });
    var genreItems = tallyTop(allGenres, 10);

    // MPAA ratings — top 3 explicit values, rest folded into "Other".
    var ratedAll = tallyTop(discs.map(function (d) { return (d.rated || '').trim(); }));
    var ratedTop = ratedAll.slice(0, 3);
    var otherCount = ratedAll.slice(3).reduce(function (s, r) { return s + r.count; }, 0);

    // Top directors / studios
    var directorItems = tallyTop(discs.map(function (d) { return (d.director || '').trim(); })
      .filter(function (s) { return s && s !== 'N/A'; }), 6);
    var studioItems = tallyTop(discs.map(function (d) { return (d.studio || '').trim(); }), 8);

    return [
      statsIntroHTML(total, yearSpan),
      statsHeroHTML(total, bluray, uhd, appletv, formatSum, totalRuntime, runtimeDays, avgImdbN, imdbScores.length, yearSpan, oldest, newest, minYear, maxYear),
      statsRowAHTML(decades, formatSum, bluray, uhd, appletv),
      statsRowBHTML(imdbScores, avgImdbN, ripped, rippableTotal, notRipped, rippedPct, ratedTop, otherCount),
      statsTreemapHTML(genreItems),
      statsHighlightsHTML(topRated, longest, newest, oldest),
      statsRowEHTML(directorItems, studioItems)
    ].join('');
  }

  // Intro: eyebrow + section H1 + supporting blurb + sync chip.
  function statsIntroHTML(total, yearSpan) {
    var now = new Date();
    var MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    var stamp = 'SYNCED · ' + MONTHS[now.getMonth()] + ' ' + now.getDate() + ' ' + now.getFullYear();
    var blurb = fmtThousands(total) + ' titles' +
      (yearSpan ? ' spanning ' + yearSpan + ' year' + (yearSpan === 1 ? '' : 's') + ' of cinema' : '') +
      ' — broken down by format, era, rating and the directors who keep showing up.';
    return '<section class="stats-v2">' +
      '<div class="sv2-intro">' +
        '<div class="sv2-intro-left">' +
          '<div class="sv2-eyebrow">LIBRARY STATS</div>' +
          '<h1 class="sv2-h1">The shape of your<br>collection.</h1>' +
          '<p class="sv2-blurb">' + escapeHtml(blurb) + '</p>' +
        '</div>' +
        '<div class="sv2-sync">' + stamp + '</div>' +
      '</div>';
  }

  // The 4-tile "fun-fact" hero strip with per-tile micro-visuals.
  function statsHeroHTML(total, bluray, uhd, appletv, formatSum, totalRuntime, runtimeDays, avgImdbN, scoredCount, yearSpan, oldest, newest, minYear, maxYear) {
    var atvPct = formatSum ? (appletv / formatSum * 100) : 0;
    var bdPct = formatSum ? (bluray / formatSum * 100) : 0;
    var uhdPct = formatSum ? (uhd / formatSum * 100) : 0;
    var ratingFrac = avgImdbN > 0 ? Math.round(avgImdbN * 10) : 0; // out of 100
    var oldTitle = oldest ? oldest.disc.title : '—';
    var newTitle = newest ? newest.disc.title : '—';
    var avgDisplay = scoredCount ? avgImdbN.toFixed(1) : '—';

    function tile(eyebrow, num, unit, sub, micro) {
      return '<div class="sv2-tile">' +
        '<div class="sv2-tile-eb">' + eyebrow + '</div>' +
        '<div class="sv2-tile-num"><span class="sv2-tile-n">' + num + '</span>' +
          (unit ? '<span class="sv2-tile-u">' + unit + '</span>' : '') + '</div>' +
        '<div class="sv2-tile-sub">' + escapeHtml(sub) + '</div>' +
        '<div class="sv2-tile-micro">' + micro + '</div>' +
      '</div>';
    }

    // Format split bar: 3 segments, widths proportional to share.
    var splitBar = '<div class="sv2-splitbar">' +
      '<div style="width:' + atvPct.toFixed(2) + '%;background:' + STATS_FMT_COLOR.appletv + '"></div>' +
      '<div style="width:' + bdPct.toFixed(2) + '%;background:' + STATS_FMT_COLOR.bluray + '"></div>' +
      '<div style="width:' + uhdPct.toFixed(2) + '%;background:' + STATS_FMT_COLOR.uhd + '"></div>' +
    '</div>';

    // Tiny equalizer of accent bars — purely decorative, fixed heights.
    var EQ_HEIGHTS = [9, 15, 8, 19, 12, 17, 9, 14, 11];
    var EQ_OPACITY = [0.55, 0.7, 0.5, 1, 0.65, 0.85, 0.5, 0.7, 0.6];
    var eq = '<div class="sv2-eq">' + EQ_HEIGHTS.map(function (h, i) {
      return '<span style="height:' + h + 'px;opacity:' + EQ_OPACITY[i] + '"></span>';
    }).join('') + '</div>';

    var meter = '<div class="sv2-meter"><div style="width:' + ratingFrac + '%;background:' + STATS_ACCENT_HMETER + '"></div></div>';

    var timeline = '<div class="sv2-timeline">' +
      '<div class="sv2-timeline-line"></div>' +
      '<div class="sv2-timeline-dot"></div>' +
      '<div class="sv2-timeline-spacer"></div>' +
      '<div class="sv2-timeline-dot"></div>' +
    '</div>' +
    '<div class="sv2-timeline-labels"><span>' + (minYear || '—') + '</span><span>' + (maxYear || '—') + '</span></div>';

    var titleSub = fmtThousands(formatSum) + ' disc' + (formatSum === 1 ? '' : 's') + ' & digital files';
    var runtimeSub = fmtThousands(totalRuntime) + ' minutes, back to back';
    var avgSub = scoredCount + ' rated title' + (scoredCount === 1 ? '' : 's');
    var spanSub = (oldTitle !== '—' && newTitle !== '—') ? (oldTitle + ' → ' + newTitle) : 'Add dated titles to see your span';

    return '<div class="sv2-hero">' +
      tile('IN THE LIBRARY', fmtThousands(total), 'title' + (total === 1 ? '' : 's'), titleSub, splitBar) +
      tile('TOTAL RUNTIME', runtimeDays, 'day' + (runtimeDays === '1.0' ? '' : 's'), runtimeSub, eq) +
      tile('AVERAGE RATING', avgDisplay, '/ 10 IMDb', 'across ' + avgSub, meter) +
      tile('YEARS OF CINEMA', (yearSpan || '—'), 'years', spanSub, timeline) +
    '</div>';
  }

  // Row A: smooth area + line of titles by decade (left) and format donut (right).
  function statsRowAHTML(decades, formatSum, bluray, uhd, appletv) {
    var card = function (body) {
      return '<div class="sv2-card">' + body + '</div>';
    };

    // ---- Area chart geometry ----
    var area = '';
    var insightArea = '';
    var labels = '';
    if (decades.length >= 2) {
      var x0 = 14, x1 = 746, y0 = 22, y1 = 196;
      var maxD = decades.reduce(function (m, d) { return d.count > m ? d.count : m; }, 0) || 1;
      var pts = decades.map(function (d, i) {
        return {
          x: x0 + (x1 - x0) * (i / (decades.length - 1)),
          y: y1 - (d.count / maxD) * (y1 - y0)
        };
      });
      var lineD = smoothPath(pts);
      var last = pts[pts.length - 1];
      var areaD = lineD + ' L ' + last.x.toFixed(2) + ' ' + y1 + ' L ' + pts[0].x.toFixed(2) + ' ' + y1 + ' Z';
      var peakI = 0;
      decades.forEach(function (d, i) { if (d.count > decades[peakI].count) peakI = i; });
      var peak = pts[peakI];
      var peakDec = decades[peakI];
      var postMillenniumCount = decades.reduce(function (s, d) {
        return s + (d.decade >= 2000 ? d.count : 0);
      }, 0);
      var totalDated = decades.reduce(function (s, d) { return s + d.count; }, 0);
      var postPct = totalDated ? Math.round(postMillenniumCount / totalDated * 100) : 0;
      area =
        '<svg class="sv2-area-svg" viewBox="0 0 760 230" preserveAspectRatio="none">' +
          '<defs><linearGradient id="sv2AreaGrad" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="' + STATS_ACCENT.solid + '" stop-opacity="0.42"></stop>' +
            '<stop offset="60%" stop-color="' + STATS_ACCENT.solid + '" stop-opacity="0.10"></stop>' +
            '<stop offset="100%" stop-color="' + STATS_ACCENT.solid + '" stop-opacity="0"></stop>' +
          '</linearGradient></defs>' +
          '<line x1="14" y1="196" x2="746" y2="196" stroke="rgba(255,255,255,0.08)" stroke-width="1"></line>' +
          '<path d="' + areaD + '" fill="url(#sv2AreaGrad)"></path>' +
          '<path d="' + lineD + '" fill="none" stroke="' + STATS_ACCENT.solid + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>' +
          '<line x1="' + peak.x.toFixed(2) + '" y1="' + peak.y.toFixed(2) + '" x2="' + peak.x.toFixed(2) + '" y2="196" stroke="' + STATS_ACCENT.solid + '" stroke-width="1" stroke-dasharray="3 3" stroke-opacity="0.5"></line>' +
          '<circle cx="' + peak.x.toFixed(2) + '" cy="' + peak.y.toFixed(2) + '" r="5.5" fill="' + STATS_ACCENT.bright + '" stroke="#0a0a0d" stroke-width="2.5"></circle>' +
        '</svg>';
      labels = '<div class="sv2-area-labels">' + decades.map(function (d, i) {
        var cls = i === peakI ? ' class="peak"' : '';
        return '<span' + cls + '>' + d.label + '</span>';
      }).join('') + '</div>';
      insightArea = '<div class="sv2-insight">' +
        '<span class="sv2-dot"></span>' +
        '<span>Peak decade is the <strong>' + peakDec.decade + 's with ' + peakDec.count + ' title' + (peakDec.count === 1 ? '' : 's') + '</strong>' +
        (postPct ? ' — ' + postPct + '% of dated titles landed after 2000.' : '.') + '</span>' +
      '</div>';
    } else {
      area = '<div class="sv2-empty">Add a few titles to see your timeline.</div>';
    }
    var leftCard = card(
      '<div class="sv2-card-head">' +
        '<span class="sv2-card-eb">COLLECTION OVER TIME</span>' +
        '<span class="sv2-card-eb-r">TITLES BY DECADE</span>' +
      '</div>' +
      area + labels + insightArea
    );

    // ---- Donut ----
    var fmts = [
      { key: 'appletv', name: 'Apple TV', count: appletv, color: STATS_FMT_COLOR.appletv },
      { key: 'bluray', name: 'Blu-ray', count: bluray, color: STATS_FMT_COLOR.bluray },
      { key: 'uhd', name: '4K UHD', count: uhd, color: STATS_FMT_COLOR.uhd }
    ].filter(function (f) { return f.count > 0; });
    var R = 70, gap = 10, CIRC = 2 * Math.PI * R;
    var cum = 0;
    var donutSegs = '';
    var legend = '';
    var biggest = null;
    fmts.forEach(function (f) {
      if (!biggest || f.count > biggest.count) biggest = f;
      var frac = formatSum ? f.count / formatSum : 0;
      var len = Math.max(0, frac * CIRC - gap);
      donutSegs +=
        '<g data-action="stats-drill" data-fmt="' + f.key + '" class="sv2-donut-seg" title="Show ' + escapeHtml(f.name) + ' titles">' +
          '<circle cx="90" cy="90" r="' + R + '" fill="none" stroke="' + f.color + '" stroke-width="25"' +
            ' stroke-dasharray="' + len.toFixed(2) + ' ' + (CIRC - len).toFixed(2) + '"' +
            ' stroke-dashoffset="' + (-cum * CIRC).toFixed(2) + '"></circle>' +
        '</g>';
      cum += frac;
      var pct = formatSum ? Math.round(frac * 100) : 0;
      legend +=
        '<div class="sv2-legend-row" data-action="stats-drill" data-fmt="' + f.key + '" title="Show ' + escapeHtml(f.name) + ' titles">' +
          '<span class="sv2-legend-chip" style="background:' + f.color + '"></span>' +
          '<span class="sv2-legend-name">' + escapeHtml(f.name) + '</span>' +
          '<span class="sv2-legend-pct">' + pct + '%</span>' +
          '<span class="sv2-legend-count">' + fmtThousands(f.count) + '</span>' +
        '</div>';
    });
    var biggestInsight = biggest
      ? '<div class="sv2-insight"><span class="sv2-dot" style="background:' + biggest.color + '"></span>' +
        '<span><strong>' + escapeHtml(biggest.name) + '</strong> is ' + Math.round(biggest.count / formatSum * 100) + '% of all format chips.</span></div>'
      : '';
    var rightCard = card(
      '<span class="sv2-card-eb">BY FORMAT</span>' +
      '<div class="sv2-donut-wrap">' +
        '<div class="sv2-donut">' +
          '<svg width="180" height="180" viewBox="0 0 180 180">' +
            '<g transform="rotate(-90 90 90)">' +
              '<circle cx="90" cy="90" r="' + R + '" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="25"></circle>' +
              donutSegs +
            '</g>' +
          '</svg>' +
          '<div class="sv2-donut-center">' +
            '<span class="sv2-donut-n">' + fmtThousands(formatSum) + '</span>' +
            '<span class="sv2-donut-l">DISCS &amp; FILES</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="sv2-legend">' + legend + '</div>' +
      biggestInsight
    );

    return '<div class="sv2-row sv2-row-a">' + leftCard + rightCard + '</div>';
  }

  // Row B: IMDb histogram (left) + a vertical stack of Plex ring + rating mix (right).
  function statsRowBHTML(imdbScores, avgImdbN, ripped, rippableTotal, notRipped, rippedPct, ratedTop, otherCount) {
    // Histogram buckets (low → high so the AVG marker reads left → right).
    var buckets = [
      { label: '<6', test: function (n) { return n < 6; } },
      { label: '6',  test: function (n) { return n >= 6 && n < 7; } },
      { label: '7',  test: function (n) { return n >= 7 && n < 8; } },
      { label: '8',  test: function (n) { return n >= 8 && n < 9; } },
      { label: '9+', test: function (n) { return n >= 9; } }
    ];
    var bucketCounts = buckets.map(function (b) { return imdbScores.filter(b.test).length; });
    var maxBucket = bucketCounts.reduce(function (m, c) { return c > m ? c : m; }, 0) || 1;
    var sweetIdx = 2;
    var sweetCount = bucketCounts[sweetIdx];
    var avgPct = imdbScores.length ? ratingPositionPct(avgImdbN) : 0;
    var histoBars = buckets.map(function (b, i) {
      var c = bucketCounts[i];
      var hPct = Math.max(0, c / maxBucket * 100);
      return '<div class="sv2-histo-col">' +
        '<span class="sv2-histo-n">' + c + '</span>' +
        '<div class="sv2-histo-bar" data-h="' + hPct.toFixed(2) + '" style="height:0;background:' + STATS_ACCENT_VMETER + '"></div>' +
      '</div>';
    }).join('');
    var histoLabels = buckets.map(function (b) {
      return '<span>' + b.label + '</span>';
    }).join('');
    var avgMarker = imdbScores.length
      ? '<div class="sv2-histo-avg" style="left:' + avgPct.toFixed(2) + '%"></div>' +
        '<div class="sv2-histo-avg-pill" style="left:' + avgPct.toFixed(2) + '%">AVG ' + avgImdbN.toFixed(1) + '</div>'
      : '';
    var histoCard =
      '<div class="sv2-card sv2-histo-card">' +
        '<div class="sv2-card-head">' +
          '<span class="sv2-card-eb">IMDB RATING SPREAD</span>' +
          '<span class="sv2-card-eb-r">' + imdbScores.length + ' SCORED</span>' +
        '</div>' +
        '<div class="sv2-histo">' +
          '<div class="sv2-histo-bars">' + histoBars + '</div>' +
          avgMarker +
        '</div>' +
        '<div class="sv2-histo-labels">' + histoLabels + '</div>' +
        (sweetCount
          ? '<div class="sv2-insight"><span class="sv2-dot"></span><span><strong>' + sweetCount + ' title' + (sweetCount === 1 ? '' : 's') +
            '</strong> sit in the 7.0–7.9 sweet spot.</span></div>'
          : '') +
      '</div>';

    // Plex ring
    var ringR = 64, ringC = 2 * Math.PI * ringR;
    var plexFrac = rippableTotal ? ripped / rippableTotal : 0;
    var plexDash = (plexFrac * ringC).toFixed(2) + ' ' + ringC.toFixed(2);
    var plexCard =
      '<div class="sv2-card sv2-plex-card" data-action="stats-drill" data-plex="plex" title="Show ripped titles">' +
        '<div class="sv2-plex-ring">' +
          '<svg width="128" height="128" viewBox="0 0 160 160">' +
            '<g transform="rotate(-90 80 80)">' +
              '<circle cx="80" cy="80" r="' + ringR + '" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="20"></circle>' +
              '<circle cx="80" cy="80" r="' + ringR + '" fill="none" stroke="' + STATS_ACCENT.solid + '" stroke-width="20" stroke-linecap="round" stroke-dasharray="' + plexDash + '"></circle>' +
            '</g>' +
          '</svg>' +
          '<div class="sv2-plex-center">' +
            '<span class="sv2-plex-n">' + rippedPct + '%</span>' +
            '<span class="sv2-plex-l">RIPPED</span>' +
          '</div>' +
        '</div>' +
        '<div class="sv2-plex-body">' +
          '<span class="sv2-card-eb">PLEX ARCHIVE</span>' +
          '<div class="sv2-plex-frac">' + fmtThousands(ripped) + ' <span>/ ' + fmtThousands(rippableTotal) + '</span></div>' +
          '<div class="sv2-plex-sub">rippable discs archived</div>' +
          '<div class="sv2-plex-rem">' + fmtThousands(notRipped) + ' still on the to-rip pile</div>' +
        '</div>' +
      '</div>';

    // Rating mix — top 3 explicit MPAA values + Other.
    var mixSegs = ratedTop.slice();
    if (otherCount > 0) mixSegs.push({ key: 'Other', count: otherCount });
    var mixTotal = mixSegs.reduce(function (s, m) { return s + m.count; }, 0);
    var MIX_PALETTE = [STATS_ACCENT.solid, STATS_ACCENT.deep, '#6e6244', '#34322b'];
    var MIX_FG = ['#1a1206', '#fbf6ea', '#fbf6ea', '#c8c4ba'];
    var stack = '';
    var chips = '';
    mixSegs.forEach(function (m, i) {
      var w = mixTotal ? (m.count / mixTotal * 100) : 0;
      var label = m.key || '—';
      var safeLabel = escapeHtml(label);
      var drill = (label && label !== 'Other' && label !== '—')
        ? ' data-action="stats-drill" data-q="' + safeLabel + '"'
        : '';
      stack +=
        '<div class="sv2-mix-seg"' + drill + ' style="width:' + w.toFixed(2) + '%;background:' + MIX_PALETTE[i] + '" title="' + safeLabel + ' · ' + m.count + '">' +
          '<span style="color:' + MIX_FG[i] + '">' + safeLabel + '</span>' +
        '</div>';
      chips +=
        '<div class="sv2-mix-chip"' + drill + '>' +
          '<span class="sv2-mix-dot" style="background:' + MIX_PALETTE[i] + '"></span>' +
          '<span class="sv2-mix-name">' + safeLabel + '</span>' +
          '<span class="sv2-mix-count">' + m.count + '</span>' +
        '</div>';
    });
    var mixCard =
      '<div class="sv2-card sv2-mix-card">' +
        '<span class="sv2-card-eb">RATING MIX</span>' +
        (mixSegs.length
          ? '<div class="sv2-mix-stack">' + stack + '</div>' +
            '<div class="sv2-mix-chips">' + chips + '</div>'
          : '<div class="sv2-empty">No MPAA ratings on file yet.</div>') +
      '</div>';

    return '<div class="sv2-row sv2-row-b">' +
      histoCard +
      '<div class="sv2-rstack">' + plexCard + mixCard + '</div>' +
    '</div>';
  }

  // Genre treemap (squarified, % horizontal × px vertical against a 1264×300 box).
  function statsTreemapHTML(genreItems) {
    if (!genreItems.length) {
      return '<div class="sv2-card sv2-treemap-card">' +
        '<span class="sv2-card-eb">GENRE LANDSCAPE</span>' +
        '<div class="sv2-empty">Add genres to titles to see the landscape.</div>' +
      '</div>';
    }
    var TW = 1264, TH = 300;
    var items = genreItems.map(function (g) { return { name: g.key, value: g.count }; });
    var tiles = squarify(items, 0, 0, TW, TH);
    var sorted = tiles.slice().sort(function (a, b) { return b.value - a.value; });
    var n = sorted.length;
    var byName = {};
    sorted.forEach(function (t, i) {
      var L = n > 1 ? (0.80 - (i / (n - 1)) * 0.40) : 0.80;
      byName[t.name] = {
        bg: 'oklch(' + L.toFixed(3) + ' 0.105 ' + STATS_ACCENT.hue + ')',
        fg: L > 0.60 ? '#1c1606' : '#f6efdd',
        sub: L > 0.60 ? 'rgba(28,22,6,0.6)' : 'rgba(246,239,221,0.6)'
      };
    });
    var top3 = sorted.slice(0, 3).map(function (t) { return t.name; });
    var top3Sum = sorted.slice(0, 3).reduce(function (s, t) { return s + t.value; }, 0);
    var totalSum = sorted.reduce(function (s, t) { return s + t.value; }, 0);
    var top3Pct = totalSum ? Math.round(top3Sum / totalSum * 100) : 0;
    var tilesHTML = tiles.map(function (t) {
      var meta = byName[t.name];
      var leftPct = (t.x / TW * 100);
      var widthPct = (t.w / TW * 100);
      var showLabel = t.w > 56 && t.h > 34;
      var style =
        'left:' + leftPct.toFixed(3) + '%;' +
        'top:' + t.y.toFixed(2) + 'px;' +
        'width:calc(' + widthPct.toFixed(3) + '% - 4px);' +
        'height:' + (t.h - 4).toFixed(2) + 'px;' +
        'background:' + meta.bg + ';';
      return '<div class="sv2-tm-tile" data-action="stats-drill" data-q="' + escapeHtml(t.name) + '" style="' + style + '" title="' + escapeHtml(t.name) + ' · ' + t.value + '">' +
        (showLabel
          ? '<div class="sv2-tm-name" style="color:' + meta.fg + '">' + escapeHtml(t.name) + '</div>' +
            '<div class="sv2-tm-count" style="color:' + meta.sub + '">' + t.value + '</div>'
          : '') +
      '</div>';
    }).join('');
    var topNames = top3.length === 3
      ? top3[0] + ', ' + top3[1] + ' & ' + top3[2]
      : top3.join(', ');
    return '<div class="sv2-card sv2-treemap-card">' +
      '<div class="sv2-card-head">' +
        '<span class="sv2-card-eb">GENRE LANDSCAPE</span>' +
        '<span class="sv2-card-eb-r">SIZED BY TITLE COUNT</span>' +
      '</div>' +
      '<div class="sv2-treemap">' + tilesHTML + '</div>' +
      (top3.length ? '<div class="sv2-insight"><span class="sv2-dot"></span><span><strong>' + escapeHtml(topNames) + '</strong> dominate — together ' + top3Pct + '% of every tagged title.</span></div>' : '') +
    '</div>';
  }

  // Highlights — 4 poster-led cards. Reuses the existing pickExtreme picks.
  function statsHighlightsHTML(topRated, longest, newest, oldest) {
    function card(kicker, pick, value) {
      if (!pick) return '';
      var d = pick.disc;
      return '<div class="sv2-hl-card" data-action="open-detail" data-id="' + d.id + '" title="' + escapeHtml(d.title) + '">' +
        '<div class="sv2-hl-poster">' + posterOrHouse(d, 'card') + '</div>' +
        '<div class="sv2-hl-info">' +
          '<div class="sv2-hl-tag"><span></span>' + kicker + '</div>' +
          '<div class="sv2-hl-title">' + escapeHtml(d.title) + '</div>' +
          '<div class="sv2-hl-value">' + value + '</div>' +
        '</div>' +
      '</div>';
    }
    var cards =
      card('TOP RATED', topRated, topRated ? topRated.value.toFixed(1) + ' IMDb' : '') +
      card('LONGEST', longest, longest ? longest.value + ' min' : '') +
      card('NEWEST', newest, newest ? escapeHtml(newest.disc.year) : '') +
      card('OLDEST', oldest, oldest ? escapeHtml(oldest.disc.year) : '');
    if (!cards) return '';
    return '<div class="sv2-hl">' +
      '<span class="sv2-card-eb">COLLECTION HIGHLIGHTS</span>' +
      '<div class="sv2-hl-grid">' + cards + '</div>' +
    '</div>';
  }

  // Row E: directors leaderboard + studios tag cloud.
  function statsRowEHTML(directorItems, studioItems) {
    var directorsBody;
    if (directorItems.length) {
      var dirMax = directorItems[0].count;
      var rows = directorItems.map(function (d, i) {
        var rank = String(i + 1).padStart(2, '0');
        var pct = Math.round(d.count / dirMax * 100);
        return '<div class="sv2-dir-row" data-action="stats-drill" data-q="' + escapeHtml(d.key) + '" title="Show ' + escapeHtml(d.key) + ' titles">' +
          '<span class="sv2-dir-rank">' + rank + '</span>' +
          '<span class="sv2-dir-name">' + escapeHtml(d.key) + '</span>' +
          '<span class="sv2-dir-track"><span class="sv2-dir-fill" data-w="' + pct + '" style="width:0;background:' + STATS_ACCENT_HMETER + '"></span></span>' +
          '<span class="sv2-dir-count">' + d.count + '</span>' +
        '</div>';
      }).join('');
      directorsBody = '<div class="sv2-dir-list">' + rows + '</div>';
    } else {
      directorsBody = '<div class="sv2-empty">No director data yet.</div>';
    }
    var dirCard = '<div class="sv2-card sv2-dir-card">' +
      '<span class="sv2-card-eb">DIRECTORS ON HEAVY ROTATION</span>' +
      directorsBody +
    '</div>';

    var studiosBody;
    if (studioItems.length) {
      var studMax = studioItems[0].count;
      var pills = studioItems.map(function (s) {
        var t = studMax ? s.count / studMax : 0;
        var fs = (12.5 + t * 8).toFixed(2);
        var py = (7 + t * 3).toFixed(2);
        var px = (13 + t * 4).toFixed(2);
        var bgL = (0.17 + t * 0.13).toFixed(3);
        var bgC = (0.02 + t * 0.06).toFixed(3);
        var color = t > 0.45 ? STATS_ACCENT.bright : '#b7b3aa';
        var borderPct = Math.round(10 + t * 26);
        var style =
          'font-size:' + fs + 'px;' +
          'padding:' + py + 'px ' + px + 'px;' +
          'background:oklch(' + bgL + ' ' + bgC + ' ' + STATS_ACCENT.hue + ');' +
          'color:' + color + ';' +
          'border:1px solid color-mix(in srgb,' + STATS_ACCENT.solid + ' ' + borderPct + '%, transparent);';
        return '<span class="sv2-stud" data-action="stats-drill" data-q="' + escapeHtml(s.key) + '" style="' + style + '" title="Show ' + escapeHtml(s.key) + ' titles">' +
          escapeHtml(s.key) + ' · ' + s.count +
        '</span>';
      }).join('');
      studiosBody = '<div class="sv2-stud-cloud">' + pills + '</div>' +
        '<div class="sv2-insight"><span class="sv2-dot"></span><span><strong>' + escapeHtml(studioItems[0].key) + '</strong> is your most-stocked studio.</span></div>';
    } else {
      studiosBody = '<div class="sv2-empty">No studio data yet.</div>';
    }
    var studCard = '<div class="sv2-card sv2-stud-card">' +
      '<span class="sv2-card-eb">STUDIO FOOTPRINT</span>' +
      studiosBody +
    '</div>';

    return '<div class="sv2-row sv2-row-e">' + dirCard + studCard + '</div></section>';
  }

  // Grow the stats charts in after the view mounts. Histogram bars start at
  // height:0 and the leaderboard fills at width:0 — a double-rAF flip lets
  // the CSS transitions animate them up to their data-h / data-w targets.
  function animateStats() {
    var widthEls = document.querySelectorAll('#content .sv2-dir-fill[data-w]');
    var heightEls = document.querySelectorAll('#content .sv2-histo-bar[data-h]');
    if (!widthEls.length && !heightEls.length) return;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        widthEls.forEach(function (el) { el.style.width = el.getAttribute('data-w') + '%'; });
        heightEls.forEach(function (el) { el.style.height = el.getAttribute('data-h') + '%'; });
      });
    });
  }

  // ---------- modals ----------
  // Re-rendering rewrites #modals.innerHTML wholesale, which recreates the
  // overlay + dialog nodes and replays their fadeIn/fadeUp entrance
  // animations. While a modal stays open across interactions (toggling a
  // format, asking to delete, etc.) that replay reads as a jarring flash, so
  // we only animate a modal on the render that first mounts it.
  var modalMounted = { detail: false, add: false, settings: false };
  function renderModals() {
    var html = '';
    if (state.detailId) html += detailModalHTML(modalMounted.detail);
    if (state.addOpen) html += addModalHTML(modalMounted.add);
    if (state.settingsOpen) html += settingsModalHTML(modalMounted.settings);
    document.getElementById('modals').innerHTML = html;
    modalMounted.detail = !!state.detailId;
    modalMounted.add = !!state.addOpen;
    modalMounted.settings = !!state.settingsOpen;
    // Lock background scroll while any modal is open so the title list behind
    // the overlay stays put. The overlay (and `.overlay.top`) is its own
    // scroll container, so tall modals still scroll internally.
    document.body.classList.toggle('modal-open', !!(state.detailId || state.addOpen || state.settingsOpen));
  }

  function detailModalHTML(mounted) {
    var d = state.discs.find(function (x) { return x.id === state.detailId; });
    if (!d) return '';
    var animCls = mounted ? ' no-anim' : '';
    var fmts = discFormats(d);
    var m = fmtMeta(fmts[0]);
    var genres = (d.genre || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    var castList = (d.cast || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    var metaLine = [d.year, d.runtime, d.rated].filter(Boolean).join('   ·   ') || '—';
    var ratings = d.ratings || [];

    var del = state.confirmDelete
      ? '<span class="confirm-text">Sure?</span>' +
        '<button class="btn-del-solid" data-action="detail-do-delete" data-id="' + d.id + '">Yes, delete</button>' +
        '<button class="btn-neutral" data-action="detail-cancel-delete">Keep</button>'
      : '<button class="btn-del-outline" data-action="detail-ask-delete">Delete</button>';

    // Apple TV-only titles are digital-only and can't be ripped to Plex, so
    // the rip toggle is replaced with an explanatory notice.
    var ripControl = isRippable(d)
      ? '<button class="rip-toggle' + (d.ripped ? ' on' : '') + '" data-action="detail-toggle-rip" data-id="' + d.id + '">' +
          '<span class="rip-dot">▶</span><span class="rip-text">' + (d.ripped ? 'Ripped to Plex' : 'Not ripped') + '</span>' +
        '</button>'
      : '<div class="rip-blocked">' +
          '<span class="rip-blocked-icon">⛔</span>' +
          '<span class="rip-blocked-text">Can’t be ripped to Plex — Apple TV is digital-only.</span>' +
        '</div>';

    return '<div class="overlay' + animCls + '" data-action="overlay" data-modal="detail">' +
      '<div class="dialog' + animCls + '">' +
        '<div class="detail-cover">' + posterOrHouse(d, 'detail') + '</div>' +
        '<div class="detail-body">' +
          '<button class="close-btn" data-action="close-detail">✕</button>' +
          '<div class="chip-row">' +
            fmts.map(function (f) {
              var fm = fmtMeta(f);
              return '<span class="chip" style="--accent:' + fm.color + '"><span class="chip-dot"></span><span class="chip-label">' + fm.label + '</span></span>';
            }).join('') +
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
            ripControl +
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

  function addModalHTML(mounted) {
    var title = state.editId ? 'Edit disc' : 'Add to the stacks';
    var animCls = mounted ? ' no-anim' : '';
    return '<div class="overlay top' + animCls + '" data-action="overlay" data-modal="add">' +
      '<div class="dialog-add' + animCls + '">' +
        '<div class="modal-head"><div class="modal-title">' + title + '</div>' +
          '<button class="close-btn" data-action="close-add">✕</button></div>' +
        (state.step === 'search' ? searchStepHTML()
          : state.step === 'multi' ? multiStepHTML()
          : detailsStepHTML()) +
      '</div></div>';
  }

  // The Settings modal. Currently a single Maintenance section whose
  // "Recalculate stats" button POSTs to /api/maintenance/recalculate-stats —
  // the in-app equivalent of `scripts/backfill-omdb.js`, for when the host
  // doesn't offer easy shell access.
  function settingsModalHTML(mounted) {
    var animCls = mounted ? ' no-anim' : '';
    var s = state.recalc;
    var status = '';
    if (s.running) {
      status = '<div class="loading"><span class="spinner"></span> Recalculating — this may take a few moments…</div>';
    } else if (s.error) {
      status = '<div class="err-msg">' + escapeHtml(s.error) + '</div>';
    } else if (s.result) {
      var r = s.result;
      var rescued = Number(r.rescued) || 0;
      var parts = [];
      if (rescued) parts.push(rescued + ' score' + (rescued === 1 ? '' : 's') + ' recovered from cached OMDb data');
      parts.push(r.fixed + ' title' + (r.fixed === 1 ? '' : 's') + ' rescored from OMDb');
      if (r.stillEmpty) parts.push(r.stillEmpty + ' had no OMDb score');
      if (r.failed) parts.push(r.failed + ' lookup' + (r.failed === 1 ? '' : 's') + ' failed');
      var msg = 'Done. ' + parts.join(', ') + '.';
      if (!rescued && !r.fixable) msg = 'Nothing to recalculate — every title with an IMDb ID already has a score.';
      status = '<div class="recalc-result">' + escapeHtml(msg) + '</div>';
    }
    return '<div class="overlay top' + animCls + '" data-action="overlay" data-modal="settings">' +
      '<div class="dialog-add' + animCls + '">' +
        '<div class="modal-head"><div class="modal-title">Settings</div>' +
          '<button class="close-btn" data-action="close-settings">✕</button></div>' +
        '<div class="step">' +
          '<div class="settings-section">' +
            '<div class="settings-section-title">Maintenance</div>' +
            '<p class="settings-help">Older titles can be missing their IMDb score, which leaves the stats page average pinned to the same value no matter how many discs you add. Recalculating refetches OMDb data for any title with a known IMDb ID but no stored score and writes the result back.</p>' +
            '<div class="settings-action-row">' +
              '<button class="btn-amber" data-action="recalculate-stats"' + (s.running ? ' disabled' : '') + '>' +
                (s.running ? 'Recalculating…' : 'Recalculate stats') +
              '</button>' +
            '</div>' +
            status +
          '</div>' +
        '</div>' +
      '</div></div>';
  }

  function searchStepHTML() {
    var body = '';
    if (state.searching) {
      body = '<div class="loading"><span class="spinner"></span> Searching OMDb…</div>';
    } else if (state.searchError) {
      body = '<div class="err-msg">' + escapeHtml(state.searchError) + '</div>' +
        (state.tooMany ? imdbHintHTML() : '');
    } else if (state.searched && state.results.length === 0) {
      body = '<div class="muted-msg">No matches found.</div>';
    } else if (state.results.length) {
      var more = state.totalResults > state.results.length
        ? '<div class="results-note">Showing the top ' + state.results.length + ' of ' +
            state.totalResults + ' matches — add a year to narrow it down.</div>'
        : '';
      body = more + '<div class="results">' + state.results.map(function (r) {
        var has = r.poster;
        var thumb = has
          ? '<img class="result-thumb" src="' + escapeHtml(r.poster) + '" alt="">'
          : '<div class="result-thumb-ph">▦</div>';
        var sel = !!state.selected[r.imdbID];
        // The row picks a single title (→ details step, as before); the trailing
        // + button batch-selects it for the multi-add flow. They are sibling
        // buttons so the row click and the + click never collide.
        return '<div class="result-row' + (sel ? ' selected' : '') + '">' +
          '<button class="result-btn" data-action="pick-result" data-imdb="' + escapeHtml(r.imdbID) + '">' +
            thumb +
            '<div><div class="result-title">' + escapeHtml(r.title) + '</div>' +
            '<div class="result-year">' + escapeHtml(r.year) + '</div></div></button>' +
          '<button class="result-add' + (sel ? ' on' : '') + '" data-action="toggle-result" data-imdb="' + escapeHtml(r.imdbID) + '" title="' + (sel ? 'Selected — click to remove from batch' : 'Add to batch') + '" aria-label="' + (sel ? 'Remove from batch' : 'Add to batch') + '" aria-pressed="' + (sel ? 'true' : 'false') + '">' + (sel ? '✓' : '+') + '</button>' +
        '</div>';
      }).join('') + '</div>';
    }
    var typeSeg = function (val, label) {
      return '<button class="seg-btn' + (state.searchType === val ? ' active' : '') + '" data-action="set-search-type" data-val="' + val + '">' + label + '</button>';
    };
    var placeholder = (state.searchType === 'series' ? 'Search a TV series title' : 'Search a movie title') + ' or IMDb ID…';
    return '<div class="step">' +
      '<div class="search-type-row">' +
        '<div class="segmented">' +
          typeSeg('movie', 'MOVIE') +
          typeSeg('series', 'TV SERIES') +
        '</div>' +
      '</div>' +
      '<div class="search-row">' +
        '<input id="omdbSearch" class="search-field" placeholder="' + escapeHtml(placeholder) + '" value="' + escapeHtml(state.searchQuery) + '">' +
        '<input id="omdbYear" class="search-year" type="text" inputmode="numeric" maxlength="4" placeholder="Year" value="' + escapeHtml(state.searchYear) + '">' +
        '<button class="btn-amber" data-action="run-search">Search</button>' +
      '</div>' + body +
      skipRowHTML() +
    '</div>';
  }

  // The footer link below the search results. With no titles batch-selected it
  // is the "skip to manual entry" escape hatch; once one or more results are
  // ticked it becomes "Add all", which carries the batch into the multi-add
  // step (shared formats + Plex status for every selected title).
  function skipRowHTML() {
    var n = Object.keys(state.selected).length;
    if (n > 0) {
      return '<div class="skip-row"><button class="add-all-link" data-action="add-all">Add all (' + n + ') →</button></div>';
    }
    return '<div class="skip-row"><button class="skip-link" data-action="start-manual">Skip — enter details manually</button></div>';
  }

  // Shown when OMDB reports "Too many results": point the user at the IMDb-ID
  // escape hatch (the same search box accepts an `tt…` code for a direct lookup).
  function imdbHintHTML() {
    return '<div class="imdb-hint">Too many matches to list. Add a year above, or paste the ' +
      'title’s IMDb ID (e.g. <code>tt1175491</code>) into the search box to jump straight ' +
      'to it — find it in the title’s imdb.com URL.</div>';
  }

  // Multi-add step: one shared format + Plex-status choice applied to every
  // batch-selected title. Reached from the search step's "Add all" link.
  function multiStepHTML() {
    var items = Object.keys(state.selected).map(function (k) { return state.selected[k]; });
    var n = items.length;
    var fmts = Array.isArray(state.multiForm.formats) ? state.multiForm.formats : [];
    var has = function (k) { return fmts.indexOf(k) >= 0; };
    var fr = !!state.multiForm.ripped;
    var fmtOpt = function (key, dotCls, selCls, label) {
      return '<button class="fmt-opt' + (has(key) ? ' ' + selCls : '') + '" data-action="multi-format" data-fmt="' + key + '">' +
        '<span class="fmt-opt-dot ' + dotCls + '"></span><span class="fmt-opt-text">' + label + '</span></button>';
    };
    var list = '<div class="multi-list">' + items.map(function (r) {
      var thumb = r.poster
        ? '<img class="result-thumb" src="' + escapeHtml(r.poster) + '" alt="">'
        : '<div class="result-thumb-ph">▦</div>';
      return '<div class="multi-item">' + thumb +
        '<div class="multi-item-info"><div class="result-title">' + escapeHtml(r.title) + '</div>' +
        '<div class="result-year">' + escapeHtml(r.year) + '</div></div>' +
        '<button class="result-add on" data-action="toggle-result" data-imdb="' + escapeHtml(r.imdbID) + '" title="Remove from batch" aria-label="Remove from batch">✕</button>' +
      '</div>';
    }).join('') + '</div>';
    var saveLabel = state.multiSaving
      ? 'Adding ' + state.multiDone + ' / ' + n + '…'
      : 'Save ' + n + ' title' + (n === 1 ? '' : 's');
    return '<div class="step">' +
      '<div class="multi-head">Pick the format and Plex status to apply to all ' + n + ' selected title' + (n === 1 ? '' : 's') + '.</div>' +
      list +
      '<div class="fmt-rip-row">' +
        '<div><label class="field-label">Formats (one or more)</label><div class="fmt-opts">' +
          fmtOpt('bluray',  'blu', 'sel-blu', 'Blu-ray') +
          fmtOpt('uhd',     'uhd', 'sel-uhd', '4K UHD') +
          fmtOpt('appletv', 'atv', 'sel-atv', 'Apple TV') +
        '</div></div>' +
        '<div><label class="field-label">Ripped to Plex</label>' +
          '<button class="rip-pill' + (fr ? ' on' : '') + '" data-action="multi-ripped">' +
            '<span class="rip-dot">▶</span><span class="rip-text">' + (fr ? 'Yes — in Plex' : 'Not ripped') + '</span>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="footer-row">' +
        '<button class="back-link" data-action="back-to-search"' + (state.multiSaving ? ' disabled' : '') + '>← Back to search</button>' +
        '<button class="btn-save" data-action="save-multi"' + (state.multiSaving ? ' disabled' : '') + '>' + saveLabel + '</button>' +
      '</div>' +
    '</div>';
  }

  function detailsStepHTML() {
    var f = state.form;
    var dw = state.duplicateWarning;
    var dupWarn = dw
      ? '<div class="dup-warn">' +
          '<div class="dup-warn-msg">' + escapeHtml(dw.message) +
            (dw.id ? ' <button class="dup-warn-link" data-action="dup-view" data-id="' + escapeHtml(dw.id) + '">View "' + escapeHtml(dw.title || 'existing disc') + '"</button>' : '') +
          '</div>' +
        '</div>'
      : '';
    var hasMeta = !!(f.director || f.cast);
    var metaStrip = hasMeta
      ? '<div class="meta-strip">' +
          (f.poster ? '<img class="meta-thumb" src="' + escapeHtml(f.poster) + '" alt="">' : '') +
          '<div><div class="meta-cap">Pulled from OMDb</div>' +
            '<div class="meta-line2"><span class="k">Dir.</span> ' + escapeHtml(f.director || '—') + '</div>' +
            '<div class="meta-line2"><span class="k">Cast</span> ' + escapeHtml(f.cast || '—') + '</div></div>' +
        '</div>'
      : '';
    var fmts = Array.isArray(f.formats) ? f.formats : [];
    var has = function (k) { return fmts.indexOf(k) >= 0; };
    var fr = !!f.ripped;
    var posterNote = f.poster
      ? '<div class="meta-cap" style="margin-top:6px;">Uploading a file overrides the OMDb poster.</div>' : '';
    var fmtOpt = function (key, dotCls, selCls, label) {
      return '<button class="fmt-opt' + (has(key) ? ' ' + selCls : '') + '" data-action="form-format" data-fmt="' + key + '">' +
        '<span class="fmt-opt-dot ' + dotCls + '"></span><span class="fmt-opt-text">' + label + '</span></button>';
    };

    return '<div class="step">' + dupWarn + metaStrip +
      '<div class="field-grid grid-title-year">' +
        field('Title', 'title', f.title, 'Movie title') +
        field('Year', 'year', f.year, '2024') +
      '</div>' +
      '<div class="field-grid" style="margin-top:13px;">' +
        field('Sort title (optional)', 'sortTitle', f.sortTitle, 'e.g. Matrix 2') +
      '</div>' +
      '<div class="field-grid grid-2">' +
        field('Studio', 'studio', f.studio, 'e.g. Warner Bros.') +
        field('Distributor / Label', 'distributor', f.distributor, 'e.g. Criterion') +
      '</div>' +
      '<div class="fmt-rip-row">' +
        '<div><label class="field-label">Formats (one or more)</label><div class="fmt-opts">' +
          fmtOpt('bluray',  'blu', 'sel-blu', 'Blu-ray') +
          fmtOpt('uhd',     'uhd', 'sel-uhd', '4K UHD') +
          fmtOpt('appletv', 'atv', 'sel-atv', 'Apple TV') +
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
    state.form = blankForm(); state.form.formats = rememberedFormats();
    state.results = []; state.totalResults = 0;
    state.searchQuery = ''; state.searchYear = '';
    state.searchType = 'movie';
    state.searched = false; state.searchError = ''; state.tooMany = false;
    state.duplicateWarning = null;
    state.selected = {};
    state.multiForm = { formats: rememberedFormats(), ripped: false };
    state.multiSaving = false; state.multiDone = 0;
    renderModals();
    var input = document.getElementById('omdbSearch');
    if (input) input.focus();
  }

  // Scroll the wall so the first card whose sortable title starts with
  // `letter` sits just below the sticky site header.
  function jumpToLetter(letter) {
    var card = document.querySelector('.wall .card[data-letter="' + letter + '"]');
    if (!card) return;
    var header = document.querySelector('.site-header');
    var offset = (header ? header.offsetHeight : 0) + 12;
    var top = card.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: top, behavior: 'smooth' });
  }
  function closeAdd() {
    state.addOpen = false; state.editId = null; state.duplicateWarning = '';
    renderModals();
  }
  function openSettings() {
    state.settingsOpen = true;
    // Reset any prior run's result so reopening starts clean. An in-flight
    // request (state.recalc.running) is left alone — closing/reopening
    // shouldn't cancel work that's already happening on the server.
    if (!state.recalc.running) state.recalc = { running: false, result: null, error: '' };
    renderModals();
  }
  function closeSettings() { state.settingsOpen = false; renderModals(); }

  function recalculateStats() {
    if (state.recalc.running) return;
    state.recalc = { running: true, result: null, error: '' };
    renderModals();
    api('/api/maintenance/recalculate-stats', { method: 'POST' }).then(function (data) {
      state.recalc.running = false;
      state.recalc.result = data;
      renderModals();
      // Pull the freshly-scored discs back so the stats page reflects the fix
      // the moment the user navigates to it.
      return loadDiscs();
    }).catch(function (err) {
      state.recalc.running = false;
      state.recalc.error = 'Could not recalculate: ' + err.message;
      renderModals();
    });
  }

  // Preserve whatever the user has typed (uncontrolled inputs) before re-render.
  function syncSearchQueryFromDom() {
    var input = document.getElementById('omdbSearch');
    if (input) state.searchQuery = input.value;
    var yearInput = document.getElementById('omdbYear');
    if (yearInput) state.searchYear = yearInput.value;
  }

  function runSearch() {
    syncSearchQueryFromDom();
    var q = state.searchQuery.trim();
    if (!q) return;
    // An IMDb ID typed into the search box is a direct lookup, not a title
    // search — the escape hatch when a title is too common to list.
    if (/^tt\d+$/i.test(q)) return lookupByImdb(q.toLowerCase());
    var y = state.searchYear.trim();
    state.searching = true; state.searchError = ''; state.tooMany = false;
    state.searched = true; state.results = []; state.totalResults = 0;
    renderModals();
    var url = '/api/omdb/search?q=' + encodeURIComponent(q) + '&type=' + encodeURIComponent(state.searchType);
    if (/^\d{4}$/.test(y)) url += '&y=' + encodeURIComponent(y);
    api(url).then(function (data) {
      state.results = (data.results || []).map(function (r) {
        return { imdbID: r.imdbID, title: r.title, year: r.year, poster: r.poster || '' };
      });
      state.totalResults = data.totalResults || state.results.length;
      state.searching = false; renderModals();
    }).catch(function (err) {
      state.searching = false;
      state.tooMany = err.code === 'OMDB_TOO_MANY';
      state.searchError = err.message + ' — or add this disc manually below.';
      renderModals();
    });
  }

  // Look a title up directly by IMDb ID (OMDB's `i` param, via the detail
  // proxy) and jump to the details form, bypassing the result list entirely.
  function lookupByImdb(imdbID) {
    state.searching = true; state.searchError = ''; state.tooMany = false;
    state.searched = true; state.results = []; state.totalResults = 0;
    renderModals();
    api('/api/omdb/detail/' + encodeURIComponent(imdbID)).then(function (d) {
      applyDetailToForm(d, imdbID, null);
      state.searching = false; state.step = 'details'; renderModals();
    }).catch(function (err) {
      state.searching = false;
      state.searchError = err.message + ' — check the IMDb ID, or add this disc manually below.';
      renderModals();
    });
  }

  // Populate the add form from an OMDB detail payload. `r` is an optional
  // matching search-result row used to fall back on title/year/poster.
  function applyDetailToForm(d, imdbID, r) {
    state.form = {
      title: d.title || (r && r.title) || '', sortTitle: '', year: (d.year || (r && r.year) || '').slice(0, 4),
      formats: state.form.formats.slice(), studio: d.studio || '', distributor: '', ripped: false,
      poster: d.poster_url || '', director: d.director || '', cast: d.cast || d.actors || '',
      plot: d.plot || '', genre: d.genre || '', runtime: d.runtime || '', rated: d.rated || '',
      ratings: d.ratings || [], imdbRating: d.imdb_rating || '', imdbID: d.imdb_id || imdbID,
    };
  }

  function pickResult(imdbID) {
    var r = state.results.find(function (x) { return x.imdbID === imdbID; });
    state.searching = true; renderModals();
    api('/api/omdb/detail/' + encodeURIComponent(imdbID)).then(function (d) {
      applyDetailToForm(d, imdbID, r);
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
    state.duplicateWarning = null;
    state.form = {
      title: d.title, sortTitle: d.sortTitle || '', year: d.year, formats: discFormats(d).slice(), studio: d.studio, distributor: d.distributor,
      ripped: d.ripped, poster: d.hasUpload ? '' : d.poster, director: d.director, cast: d.cast,
      plot: d.plot, genre: d.genre, runtime: d.runtime, rated: d.rated, ratings: d.ratings || [], imdbRating: d.imdbRating || '', imdbID: d.imdbID,
    };
    renderModals();
  }

  function saveForm() {
    syncFormFromDom();
    var f = state.form;
    if (!f.title || !f.title.trim()) return;
    // Grab the chosen file before re-rendering — renderModals() rewrites the
    // modal HTML, which would wipe the <input type="file"> and its selection.
    var fileEl = document.getElementById('formImage');
    var file = fileEl && fileEl.files && fileEl.files[0];
    state.saving = true; state.duplicateWarning = ''; renderModals();

    var fd = new FormData();
    ['title', 'sortTitle', 'year', 'studio', 'distributor', 'director', 'cast', 'plot', 'genre', 'runtime', 'rated', 'imdbID']
      .forEach(function (k) { fd.append(k, f[k] || ''); });
    var fmts = (Array.isArray(f.formats) && f.formats.length) ? f.formats : ['bluray'];
    fmts.forEach(function (fm) { fd.append('formats', fm); });
    fd.append('ripped', f.ripped ? 'true' : 'false');
    fd.append('poster', f.poster || '');
    fd.append('ratings', JSON.stringify(f.ratings || []));
    fd.append('imdbRating', f.imdbRating || '');
    if (file) fd.append('image', file);

    var editing = state.editId;
    var url = editing ? '/api/discs/' + editing : '/api/discs';
    api(url, { method: editing ? 'PUT' : 'POST', body: fd }).then(function () {
      // Remember the format picks so the next add pre-fills them.
      if (!editing) rememberFormats(fmts);
      state.saving = false; state.addOpen = false; state.editId = null;
      return loadDiscs();
    }).then(renderModals).catch(function (err) {
      state.saving = false;
      if (err.code === 'DUPLICATE_TITLE') {
        var d = err.data || {};
        state.duplicateWarning = {
          message: err.message,
          id: d.duplicateId || '',
          title: d.duplicateTitle || '',
        };
        renderModals();
        var titleEl = document.querySelector('[data-field="title"]');
        if (titleEl) { titleEl.focus(); titleEl.select(); }
        return;
      }
      renderModals();
      alert('Could not save: ' + err.message);
    });
  }

  // Build the multipart body for one disc from a batch-selected search result
  // (`r`) enriched with its OMDB detail (`d`, may be null if the lookup failed),
  // plus the batch's shared formats / ripped choice.
  function buildDiscFormData(r, d, fmts, ripped) {
    var f = {
      title: (d && d.title) || r.title || '',
      year: (((d && d.year) || r.year || '') + '').slice(0, 4),
      studio: (d && d.studio) || '',
      director: (d && d.director) || '',
      cast: (d && (d.cast || d.actors)) || '',
      plot: (d && d.plot) || '',
      genre: (d && d.genre) || '',
      runtime: (d && d.runtime) || '',
      rated: (d && d.rated) || '',
      imdbID: (d && d.imdb_id) || r.imdbID || '',
      poster: (d && d.poster_url) || r.poster || '',
      ratings: (d && d.ratings) || [],
      imdbRating: (d && d.imdb_rating) || '',
    };
    var fd = new FormData();
    ['title', 'sortTitle', 'year', 'studio', 'distributor', 'director', 'cast', 'plot', 'genre', 'runtime', 'rated', 'imdbID']
      .forEach(function (k) { fd.append(k, f[k] || ''); });
    fmts.forEach(function (fm) { fd.append('formats', fm); });
    fd.append('ripped', ripped ? 'true' : 'false');
    fd.append('poster', f.poster || '');
    fd.append('ratings', JSON.stringify(f.ratings || []));
    fd.append('imdbRating', f.imdbRating || '');
    return fd;
  }

  // Add every batch-selected title in turn, sharing the format / Plex choice.
  // Each title is enriched from its OMDB detail (best-effort) before the POST;
  // duplicates (409) and other failures are tallied rather than aborting the run.
  function saveMulti() {
    var items = Object.keys(state.selected).map(function (k) { return state.selected[k]; });
    if (!items.length) return;
    var fmts = (Array.isArray(state.multiForm.formats) && state.multiForm.formats.length) ? state.multiForm.formats : ['bluray'];
    var ripped = !!state.multiForm.ripped;
    state.multiSaving = true; state.multiDone = 0;
    renderModals();
    rememberFormats(fmts);

    var added = 0, dupes = 0, failed = 0;
    function addOne(idx) {
      if (idx >= items.length) {
        state.multiSaving = false; state.addOpen = false; state.editId = null;
        state.selected = {};
        return loadDiscs().then(function () {
          renderModals();
          var msg = 'Added ' + added + ' title' + (added === 1 ? '' : 's') + ' to the stacks.';
          if (dupes) msg += '\n' + dupes + ' skipped — already in your collection.';
          if (failed) msg += '\n' + failed + ' could not be added.';
          alert(msg);
        });
      }
      var r = items[idx];
      return api('/api/omdb/detail/' + encodeURIComponent(r.imdbID))
        .catch(function () { return null; })
        .then(function (d) {
          return api('/api/discs', { method: 'POST', body: buildDiscFormData(r, d, fmts, ripped) })
            .then(function () { added++; })
            .catch(function (err) { if (err.code === 'DUPLICATE_TITLE') dupes++; else failed++; });
        })
        .then(function () {
          state.multiDone = idx + 1;
          if (state.step === 'multi') renderModals();
          return addOne(idx + 1);
        });
    }
    return addOne(0);
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
      if (e.target === el) {
        if (el.dataset.modal === 'detail') closeDetail();
        else if (el.dataset.modal === 'settings') closeSettings();
        else closeAdd();
      }
      return;
    }
    switch (action) {
      case 'open-add': return openAdd();
      case 'open-settings': return openSettings();
      case 'close-settings': return closeSettings();
      case 'recalculate-stats': return recalculateStats();
      case 'toggle-menu': state.menuOpen = !state.menuOpen; return renderToolbar();
      case 'set-fmt': state.fmt = el.dataset.val; renderToolbar(); renderContent(); return;
      case 'set-plex': state.plex = el.dataset.val; renderToolbar(); renderContent(); return;
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
      case 'set-search-type':
        if (state.searchType === el.dataset.val) return;
        syncSearchQueryFromDom();
        state.searchType = el.dataset.val;
        state.results = []; state.totalResults = 0; state.searched = false;
        state.searchError = ''; state.tooMany = false;
        return renderModals();
      case 'start-manual': syncFormFromDom(); state.step = 'details'; return renderModals();
      case 'back-to-search': state.step = 'search'; return renderModals();
      case 'pick-result': return pickResult(el.dataset.imdb);
      case 'toggle-result': {
        syncSearchQueryFromDom();
        var imdb = el.dataset.imdb;
        if (state.selected[imdb]) {
          delete state.selected[imdb];
        } else {
          var sr = state.results.find(function (x) { return x.imdbID === imdb; });
          if (sr) state.selected[imdb] = { imdbID: sr.imdbID, title: sr.title, year: sr.year, poster: sr.poster };
        }
        // Removing the last batch item from the multi step drops back to search.
        if (state.step === 'multi' && Object.keys(state.selected).length === 0) state.step = 'search';
        return renderModals();
      }
      case 'add-all':
        syncSearchQueryFromDom();
        if (Object.keys(state.selected).length === 0) return;
        state.step = 'multi';
        return renderModals();
      case 'multi-format': {
        var mkey = el.dataset.fmt;
        var mcur = Array.isArray(state.multiForm.formats) ? state.multiForm.formats.slice() : [];
        var mi = mcur.indexOf(mkey);
        if (mi >= 0) { if (mcur.length > 1) mcur.splice(mi, 1); } else { mcur.push(mkey); }
        state.multiForm.formats = mcur;
        return renderModals();
      }
      case 'multi-ripped': state.multiForm.ripped = !state.multiForm.ripped; return renderModals();
      case 'save-multi': return saveMulti();
      case 'form-format': {
        syncFormFromDom();
        var key = el.dataset.fmt;
        var cur = Array.isArray(state.form.formats) ? state.form.formats.slice() : [];
        var i = cur.indexOf(key);
        if (i >= 0) { if (cur.length > 1) cur.splice(i, 1); } else { cur.push(key); }
        state.form.formats = cur;
        return renderModals();
      }
      case 'form-ripped': syncFormFromDom(); state.form.ripped = !state.form.ripped; return renderModals();
      case 'save-form': return saveForm();
      case 'dup-view':
        closeAdd();
        return openDetail(el.dataset.id);
      case 'az-jump': return jumpToLetter(el.dataset.letter);
      case 'stats-drill': {
        // Each drill sets exactly one filter dimension and resets the others,
        // then drops the user onto the wall scrolled to the top.
        state.query = el.dataset.q || '';
        state.fmt = el.dataset.fmt || 'all';
        state.plex = el.dataset.plex || 'all';
        state.view = 'wall';
        state.menuOpen = false;
        renderToolbar(); renderContent();
        window.scrollTo(0, 0);
        return;
      }
    }
  }

  // Re-rendering the whole wall on every keystroke is wasteful at thousands of
  // cards, so update the query immediately (so nothing is lost) but debounce
  // the expensive filter + rebuild. The search input lives in the toolbar,
  // which renderContent() doesn't touch, so it keeps focus between renders.
  var searchDebounce = null;
  function onInput(e) {
    if (e.target.id === 'searchInput') {
      state.query = e.target.value;
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(function () { searchDebounce = null; renderContent(); }, 120);
    }
  }
  function onChange(e) {
    if (e.target.id === 'sortSelect') {
      state.sort = e.target.value;
      state.settings.sort = state.sort;
      saveSettings();
      renderContent();
    }
  }
  function onKeydown(e) {
    if (e.key === 'Escape') {
      if (state.addOpen) { closeAdd(); }
      else if (state.settingsOpen) { closeSettings(); }
      else if (state.detailId) { closeDetail(); }
    } else if (e.key === 'Enter' && (e.target.id === 'omdbSearch' || e.target.id === 'omdbYear')) {
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
    '<div class="site-header">' +
      '<div id="header" class="header"></div>' +
      '<div id="toolbar" class="toolbar"></div>' +
    '</div>' +
    '<div id="content" class="wrap"></div>' +
    '<div id="modals"></div>';

  state.settings = loadSettings();
  state.sort = state.settings.sort;

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
