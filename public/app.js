import { CONFIG } from './config.js';

// ---------------------------------------------------------------- helpers
const $ = (sel) => document.querySelector(sel);
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n) => (n == null ? '—' : (Math.abs(n) >= 1000 ? usd0 : usd2).format(n));
const fmtDate = (iso, opts = { year: 'numeric', month: 'short' }) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-US', opts);

// ------------------------------------------------------------------- PKCE
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function randomString(len = 64) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'[b % 64]).join('');
}
async function s256(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(digest);
}

// ---------------------------------------------------------------- session
const TOKEN_KEY = 'bb_token';
const getToken = () => {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY));
    return t && t.access_token && Date.now() < t.expiresAt ? t : null;
  } catch { return null; }
};
const setToken = (json) =>
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify({
    access_token: json.access_token,
    id_token: json.id_token || null,
    expiresAt: Date.now() + ((Number(json.expires_in) || 300) - 30) * 1000,
  }));
const clearToken = () => sessionStorage.removeItem(TOKEN_KEY);

// ------------------------------------------------------------- OAuth flow
async function beginLogin() {
  const verifier = randomString();
  const state = randomString(24);
  sessionStorage.setItem('pkce_verifier', verifier);
  sessionStorage.setItem('pkce_state', state);
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: CONFIG.CLIENT_ID,
    redirect_uri: CONFIG.REDIRECT_URI,
    scope: CONFIG.SCOPES,
    state,
    code_challenge: await s256(verifier),
    code_challenge_method: 'S256',
  });
  window.location.assign(`${CONFIG.AUTHORIZE_URL}?${p}`);
}

// Returns true if we consumed an OAuth redirect (success or handled error).
async function completeRedirect() {
  const q = new URLSearchParams(window.location.search);
  if (q.has('error')) {
    cleanUrl();
    throw new Error(`Authorization failed: ${q.get('error')} ${q.get('error_description') || ''}`);
  }
  if (!q.has('code')) return false;

  const state = q.get('state');
  const verifier = sessionStorage.getItem('pkce_verifier');
  if (!verifier || state !== sessionStorage.getItem('pkce_state')) {
    cleanUrl();
    throw new Error('OAuth state mismatch — please try signing in again.');
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: q.get('code'),
    redirect_uri: CONFIG.REDIRECT_URI,
    client_id: CONFIG.CLIENT_ID,
    code_verifier: verifier,
  });
  const res = await fetch(CONFIG.TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const text = await res.text();
  if (!res.ok) { cleanUrl(); throw new Error(`Token exchange failed (${res.status}). ${text.slice(0, 300)}`); }
  setToken(JSON.parse(text));
  sessionStorage.removeItem('pkce_verifier');
  sessionStorage.removeItem('pkce_state');
  cleanUrl();
  return true;
}
const cleanUrl = () => history.replaceState({}, '', CONFIG.REDIRECT_URI);

// ----------------------------------------------------------- API requests
class AuthExpired extends Error {}

async function apiGet(path, { query, party } = {}) {
  const token = getToken();
  if (!token) throw new AuthExpired('Not signed in');
  const url = new URL(CONFIG.API + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const headers = { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' };
  if (party) headers['X-Acting-Party-ID'] = party;

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    throw new Error(`Network error calling ${path}. The API allows any origin, so this is usually connectivity or a blocked request rather than CORS. (${e.message})`);
  }
  if (res.status === 401) { clearToken(); throw new AuthExpired('Session expired'); }
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} from ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function apiPost(path, { party, body } = {}) {
  const token = getToken();
  if (!token) throw new AuthExpired('Not signed in');
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (party) headers['X-Acting-Party-ID'] = party;

  let res;
  try {
    res = await fetch(CONFIG.API + path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  } catch (e) {
    throw new Error(`Network/CORS error calling ${path}. (${e.message})`);
  }
  if (res.status === 401) { clearToken(); throw new AuthExpired('Session expired'); }
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} from ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function decodeJwt(jwt) {
  try {
    const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(p))));
  } catch { return null; }
}
function partyFromClaims(claims) {
  if (!claims) return null;
  for (const k of ['bigbooks:party', 'bigbooks:party_id', 'party', 'party_id']) {
    const v = claims[k];
    if (typeof v === 'string' && v) return { id: v, name: claims.name || claims.email };
    if (v && typeof v === 'object' && v.id) return { id: v.id, name: v.name || claims.name };
  }
  return null;
}

// Prefer the party claim from the id_token / access_token (no network call).
// Only fall back to the documented bootstrap, GET /oauth2/userInfo, if the claim
// isn't in either token.
async function fetchParty() {
  const token = getToken();
  const fromToken = partyFromClaims(decodeJwt(token.id_token || '')) ||
                    partyFromClaims(decodeJwt(token.access_token || ''));
  if (fromToken) return fromToken;

  const res = await fetch(CONFIG.USERINFO_URL, {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
  }).catch((e) => {
    throw new Error(`Could not resolve your party: the userInfo call was blocked. The CORS allow-list is built from your client's registered redirect URIs — check that ${CONFIG.REDIRECT_URI} is registered exactly. (${e.message})`);
  });
  if (res.status === 401) { clearToken(); throw new AuthExpired('Session expired'); }
  if (!res.ok) throw new Error(`userInfo failed (${res.status})`);
  const party = partyFromClaims(await res.json());
  if (party) return party;
  throw new Error('No party claim (bigbooks:party) found in the token or userInfo. Ensure the "openid" scope is granted.');
}

function rangeForPeriod(period) {
  const before = new Date();
  const after = new Date(before);
  if (period === 'YEAR') after.setFullYear(after.getFullYear() - 5);
  else if (period === 'QUARTER') after.setFullYear(after.getFullYear() - 3);
  else after.setMonth(after.getMonth() - 13);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { after_date: iso(after), before_date: iso(before) };
}

async function loadNetworth(party, period) {
  const { after_date, before_date } = rangeForPeriod(period);
  const data = await apiGet('/v1/balance_sheets', {
    party,
    query: { time_period: period, after_date, before_date, unit_type: 'USD', perspective: 'COMPOSITE' },
  });
  const series = (data?.balanceSheets || [])
    .map((b) => b?.balanceSheet)
    .filter((s) => s && s.date && s.netWorth != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  return series;
}

async function loadAccounts(party) {
  const data = await apiGet('/v1/accounts', {
    party,
    query: {
      include: 'balance', account_types: 'ASSET,LIABILITY', unit_type: 'USD',
      perspective: 'COMPOSITE', page_size: 200, page_number: 0,
    },
  });
  return (data?.accounts || [])
    .map((a) => ({
      name: a.name,
      type: a.accountType,
      sub: a.assetType || a.liabilityType || null,
      current: a?.balance?.current ?? null,
    }))
    .filter((a) => a.current != null);
}

// -------------------------------------------------------------- rendering
function renderHero(series) {
  const cur = series[series.length - 1];
  const first = series[0];
  $('#hero-value').textContent = cur ? money(cur.netWorth) : '—';
  $('#hero-asof').textContent = cur ? `as of ${fmtDate(cur.date, { year: 'numeric', month: 'long', day: 'numeric' })}` : '';

  const box = $('#hero-change');
  box.className = 'hero-change';
  if (series.length < 2 || !first) { box.textContent = ''; return; }
  const delta = cur.netWorth - first.netWorth;
  const pct = first.netWorth ? (delta / Math.abs(first.netWorth)) * 100 : null;
  const up = delta >= 0;
  box.classList.add(up ? 'up' : 'down');
  box.innerHTML =
    `<span class="arrow" aria-hidden="true">${up ? '▲' : '▼'}</span>` +
    `<span>${up ? '+' : '−'}${money(Math.abs(delta))}</span>` +
    (pct != null ? `<span>(${up ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)</span>` : '') +
    `<span class="muted">since ${fmtDate(first.date)}</span>`;
}

function renderTiles(series) {
  const c = series[series.length - 1] || {};
  const tiles = [
    { k: 'Assets', v: c.assets, dot: 'var(--series-1)' },
    { k: 'Liabilities', v: c.liabilities, dot: 'var(--liability)' },
    { k: 'Cash on hand', v: c.cashOnHand },
    { k: 'Purchase power', v: c.purchasePower },
  ];
  $('#tiles').innerHTML = tiles.map((t) =>
    `<div class="tile"><div class="k">${t.dot ? `<span class="dot" style="background:${t.dot}"></span>` : ''}${t.k}</div>` +
    `<div class="v">${money(t.v)}</div></div>`).join('');
}

function renderChart(series, period) {
  const fig = $('#chart');
  $('#chart-range').textContent = series.length
    ? `${fmtDate(series[0].date)} – ${fmtDate(series[series.length - 1].date)}` : '';
  if (series.length < 2) {
    fig.innerHTML = `<div class="placeholder">Not enough data points to plot a trend.</div>`;
    return;
  }

  const W = 720, H = 260, pad = { t: 16, r: 16, b: 28, l: 64 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const vals = series.map((s) => s.netWorth);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }
  const padY = (max - min) * 0.12;
  min -= padY; max += padY;

  const x = (i) => pad.l + (series.length === 1 ? iw / 2 : (i / (series.length - 1)) * iw);
  const y = (v) => pad.t + ih - ((v - min) / (max - min)) * ih;

  // Gridlines + y labels (4 bands)
  const ticks = 4;
  let grid = '';
  for (let i = 0; i <= ticks; i++) {
    const v = min + ((max - min) * i) / ticks;
    const yy = y(v).toFixed(1);
    grid += `<line x1="${pad.l}" y1="${yy}" x2="${W - pad.r}" y2="${yy}" />`;
    grid += `<text class="axis-label" x="${pad.l - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle">${usd0.format(v)}</text>`;
  }

  const linePts = series.map((s, i) => `${x(i).toFixed(1)},${y(s.netWorth).toFixed(1)}`).join(' ');
  const areaPts = `${pad.l},${(pad.t + ih).toFixed(1)} ${linePts} ${(W - pad.r)},${(pad.t + ih).toFixed(1)}`;

  // x labels: first, middle, last
  const xIdx = [0, Math.floor((series.length - 1) / 2), series.length - 1];
  const xLabels = [...new Set(xIdx)].map((i) =>
    `<text class="axis-label" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${fmtDate(series[i].date, { month: 'short', year: '2-digit' })}</text>`).join('');

  const last = series.length - 1;
  fig.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Net worth from ${fmtDate(series[0].date)} to ${fmtDate(series[last].date)}">
       <g class="grid">${grid}</g>
       <polygon class="area" points="${areaPts}" />
       <polyline class="line" points="${linePts}" />
       ${xLabels}
       <line class="hoverline" x1="0" y1="${pad.t}" x2="0" y2="${pad.t + ih}" style="opacity:0" />
       <circle class="dot" r="4.5" cx="${x(last).toFixed(1)}" cy="${y(series[last].netWorth).toFixed(1)}" />
       <rect x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="transparent" />
     </svg>`;

  attachHover(fig.querySelector('svg'), series, { x, y, pad, iw, ih });
}

let tooltipEl;
function attachHover(svg, series, geo) {
  if (!tooltipEl) { tooltipEl = document.createElement('div'); tooltipEl.className = 'tooltip'; document.body.appendChild(tooltipEl); }
  const hoverline = svg.querySelector('.hoverline');
  const dot = svg.querySelector('.dot');
  const overlay = svg.querySelector('rect');
  const last = series.length - 1;

  const move = (evt) => {
    const r = svg.getBoundingClientRect();
    const px = ((evt.clientX - r.left) / r.width) * 720; // back to viewBox units
    const frac = Math.min(1, Math.max(0, (px - geo.pad.l) / geo.iw));
    const i = Math.round(frac * last);
    const s = series[i];
    const cx = geo.x(i), cy = geo.y(s.netWorth);
    hoverline.setAttribute('x1', cx); hoverline.setAttribute('x2', cx); hoverline.style.opacity = '1';
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy);
    // place tooltip using the dot's real screen position
    const sx = r.left + (cx / 720) * r.width;
    const sy = r.top + (cy / 260) * r.height;
    tooltipEl.innerHTML = `<div class="t-date">${fmtDate(s.date, { year: 'numeric', month: 'short', day: 'numeric' })}</div><div class="t-val">${money(s.netWorth)}</div>`;
    tooltipEl.style.left = `${sx}px`; tooltipEl.style.top = `${sy}px`; tooltipEl.style.opacity = '1';
  };
  const leave = () => {
    hoverline.style.opacity = '0'; tooltipEl.style.opacity = '0';
    dot.setAttribute('cx', geo.x(last)); dot.setAttribute('cy', geo.y(series[last].netWorth));
  };
  overlay.addEventListener('mousemove', move);
  overlay.addEventListener('mouseleave', leave);
}

function renderAccounts(accounts) {
  const note = $('#accounts-note');
  const host = $('#accounts');
  if (!accounts.length) { note.textContent = 'No accounts to show.'; host.innerHTML = ''; return; }
  note.textContent = '';

  const groups = [
    { label: 'Assets', type: 'ASSET', dot: 'var(--series-1)', sign: 1 },
    { label: 'Liabilities', type: 'LIABILITY', dot: 'var(--liability)', sign: -1 },
  ];
  host.innerHTML = groups.map((g) => {
    const rows = accounts.filter((a) => a.type === g.type).sort((a, b) => Math.abs(b.current) - Math.abs(a.current));
    if (!rows.length) return '';
    const subtotal = rows.reduce((s, a) => s + a.current, 0);
    const body = rows.map((a) =>
      `<tr><td class="name"><span class="dot" style="background:${g.dot}"></span>${escapeHtml(a.name)}` +
      (a.sub ? ` <span class="type">${escapeHtml(prettyType(a.sub))}</span>` : '') + `</td>` +
      `<td class="num${g.sign < 0 ? ' neg' : ''}">${money(a.current)}</td></tr>`).join('');
    return `<table class="accounts"><thead><tr><th>${g.label}</th><th class="num">${money(subtotal)}</th></tr></thead><tbody>${body}</tbody></table>`;
  }).join('<div style="height:14px"></div>');
}
const prettyType = (t) => String(t).replace(/^_/, '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// -------------------------------------------------------------- Plaid Link
// Flow: POST /v1/plaid/public/token → Plaid.create(link_token) → user picks a
// bank → onSuccess(publicToken, metadata) → POST /v1/plaid/access/token, which
// exchanges the token server-side (BigBooks holds the Plaid secret) and imports
// the item. Then we refresh the dashboard.
let linking = false;
function setLinkBusy(b) {
  linking = b;
  for (const id of ['#link-btn', '#empty-link-btn']) {
    const el = $(id);
    if (el) { el.disabled = b; el.textContent = b ? 'Opening Plaid…' : el.dataset.label || el.textContent; }
  }
}

async function openPlaidLink() {
  if (linking) return;
  if (!state.party) { showError('Sign in before linking an account.'); return; }
  if (!window.Plaid) { showError('Plaid Link failed to load — check your network or ad blocker, then reload.'); return; }
  hideError();
  setLinkBusy(true);
  try {
    const { token } = await apiPost('/v1/plaid/public/token', {
      party: state.party,
      body: {
        clientName: 'BigBooks Net Worth',
        language: 'en',
        countryCodes: ['US'],
        clientUserId: state.party,
      },
    });
    const handler = window.Plaid.create({
      token,
      onSuccess: async (publicToken, metadata) => {
        try {
          await exchangePublicToken(publicToken, metadata);
          flash('Account linked — importing balances…');
          await refresh();
        } catch (e) {
          if (e instanceof AuthExpired) return showConnect('Your session expired. Please sign in again.', 'Session expired');
          showError('Linking failed: ' + escapeHtml(e.message));
        } finally {
          setLinkBusy(false);
        }
      },
      onExit: (err) => {
        setLinkBusy(false);
        if (err) showError('Plaid Link: ' + escapeHtml(err.display_message || err.error_message || err.error_code || 'exited before finishing.'));
      },
    });
    handler.open();
  } catch (e) {
    setLinkBusy(false);
    if (e instanceof AuthExpired) return showConnect('Your session expired. Please sign in again.', 'Session expired');
    showError('Could not start Plaid Link: ' + escapeHtml(e.message));
  }
}

function exchangePublicToken(publicToken, metadata) {
  const inst = metadata.institution || {};
  return apiPost('/v1/plaid/access/token', {
    party: state.party,
    body: {
      publicToken,
      party: state.party,
      linkSessionId: metadata.link_session_id,
      webhook: `${CONFIG.API}/v1/plaid/webhook`,
      institution: inst.institution_id ? { id: inst.institution_id, name: inst.name } : null,
      accounts: (metadata.accounts || []).map((a) => ({
        id: a.id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype,
      })),
    },
  });
}

let toastTimer;
function flash(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

// ------------------------------------------------------------------ state
const state = { party: null, period: 'MONTH' };

function showError(msg) { const e = $('#error'); e.hidden = false; e.innerHTML = msg; }
function hideError() { $('#error').hidden = true; }
function showConnect(msg, title) {
  $('#app').hidden = true; $('#connect').hidden = false;
  $('#signout').hidden = true; $('#link-btn').hidden = true;
  if (title) $('#connect-title').textContent = title;
  if (msg) $('#connect-msg').textContent = msg;
  $('#connect-btn').disabled = !CONFIG.CLIENT_ID;
}
function showApp() {
  $('#connect').hidden = true; $('#app').hidden = false;
  $('#signout').hidden = false; $('#link-btn').hidden = false;
}
function setDashboardVisible(v) {
  for (const sel of ['.hero', '#tiles', '.chart-card']) $(sel).hidden = !v;
  $$('#app .card').forEach((c) => { if (c.querySelector('#accounts')) c.hidden = !v; });
}
const $$ = (sel) => document.querySelectorAll(sel);

async function refresh() {
  hideError();
  $('#chart').innerHTML = `<div class="placeholder">Loading…</div>`;
  try {
    const [series, accounts] = await Promise.all([
      loadNetworth(state.party, state.period),
      loadAccounts(state.party).catch((e) => { console.warn('accounts:', e); return []; }),
    ]);
    // First-run empty state: nothing linked yet → show the Plaid CTA instead of empty widgets.
    const empty = !series.length && !accounts.length;
    $('#empty').hidden = !empty;
    setDashboardVisible(!empty);
    if (empty) return;

    renderHero(series); renderTiles(series); renderChart(series, state.period); renderAccounts(accounts);
    if (!series.length) showError('No balance-sheet data returned for this account and period.');
  } catch (e) {
    if (e instanceof AuthExpired) return showConnect('Your session expired. Please sign in again.', 'Session expired');
    showError(escapeHtml(e.message));
  }
}

async function startSession() {
  showApp();
  try {
    state.party = (await fetchParty()).id;
  } catch (e) {
    if (e instanceof AuthExpired) return showConnect('Your session expired. Please sign in again.', 'Session expired');
    return showError(escapeHtml(e.message));
  }
  await refresh();
}

// ------------------------------------------------------------------- init
function wireUi() {
  document.querySelectorAll('.period button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period button').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.period = btn.dataset.period;
      if (state.party) refresh();
    });
  });
  $('#connect-btn').addEventListener('click', () => beginLogin().catch((e) => showError(escapeHtml(e.message))));
  $('#signout').addEventListener('click', () => { clearToken(); showConnect(); });
  for (const id of ['#link-btn', '#empty-link-btn']) {
    const el = $(id);
    el.dataset.label = el.textContent;          // remember label for the busy toggle
    el.addEventListener('click', openPlaidLink);
  }
}

// Offline preview with synthetic data: open the page with #demo in the URL.
// Renders through the real render functions — no network, no auth.
function runDemo() {
  showApp();
  $('#signout').hidden = true; $('#link-btn').hidden = true;
  showError('<strong>Demo data</strong> — synthetic figures for previewing the UI. Remove <code>#demo</code> from the URL and sign in for live data.');
  const months = 13, now = new Date();
  const series = [];
  let nw = 180000;
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    nw += 4200 + Math.sin(i) * 3800 + (months - i) * 600;
    const liabilities = 145000 - (months - i) * 850;
    const cash = 18000 + Math.cos(i) * 4000;
    series.push({
      date: d.toISOString().slice(0, 10),
      netWorth: Math.round(nw),
      assets: Math.round(nw + liabilities),
      liabilities: Math.round(liabilities),
      cashOnHand: Math.round(cash),
      purchasePower: Math.round(cash + 22000),
    });
  }
  const accounts = [
    { name: 'Chase Checking', type: 'ASSET', sub: 'CHECKING', current: 14230 },
    { name: 'Ally Savings', type: 'ASSET', sub: 'SAVINGS', current: 41890 },
    { name: 'Fidelity Brokerage', type: 'ASSET', sub: 'BROKERAGE', current: 128400 },
    { name: 'Roth IRA', type: 'ASSET', sub: 'ROTH', current: 76500 },
    { name: 'Primary Residence', type: 'ASSET', sub: 'OTHER', current: 62000 },
    { name: 'Mortgage', type: 'LIABILITY', sub: 'OTHER', current: -118500 },
    { name: 'Sapphire Card', type: 'LIABILITY', sub: 'CREDIT', current: -3820 },
    { name: 'Auto Loan', type: 'LIABILITY', sub: 'OTHER', current: -14200 },
  ];
  renderHero(series); renderTiles(series); renderChart(series, 'MONTH'); renderAccounts(accounts);
}

async function init() {
  wireUi();
  if (window.location.hash.includes('demo')) return runDemo();
  if (!CONFIG.CLIENT_ID) {
    showConnect('Set CLIENT_ID in public/config.js to a public BigBooks OAuth client, then reload.', 'Configuration needed');
    return;
  }
  try {
    await completeRedirect();
  } catch (e) {
    showConnect(); showError(escapeHtml(e.message)); return;
  }
  if (getToken()) await startSession();
  else showConnect();
}

init();
