// Clip Marker: saves the time and the category of each button press during a stream.
// It posts nothing to YouTube. No dependencies. Run: node server.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 8095;
const DATA = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA, 'config.json');
const MARKER_FILE = path.join(DATA, 'markers.jsonl');
const COOLDOWN_MS = 1000;

const id = () => crypto.randomBytes(5).toString('hex');
const game = (name, buttons) => ({ id: id(), name, terms: buttons.map(([label, key]) => ({ id: id(), label, key })) });

const DEFAULTS = {
  session: null,
  games: [
    game('Elden Ring', [['Boss down', 'b'], ['Death', 'd'], ['Close call', 'c'], ['Parry', 'p'], ['Rare drop', 'r'], ['Funny moment', 'f']]),
    game('GTA 6', [['Mission success', 'm'], ['Mission failed', 'x'], ['Police chase', 'p'], ['Big crash', 'c'], ['Stunt', 's'], ['Funny moment', 'f']]),
    game('Helldivers 2', [['Mission success', 'm'], ['Extraction', 'e'], ['Team kill', 't'], ['Big explosion', 'b'], ['Close call', 'c'], ['Funny moment', 'f']]),
    game('WRC', [['Clean stage', 's'], ['Big crash', 'c'], ['Near miss', 'n'], ['Stage win', 'w'], ['Perfect corner', 'p'], ['Big jump', 'j']]),
    game('F1 25', [['Overtake', 'o'], ['Crash', 'c'], ['Race win', 'w'], ['Pole lap', 'p'], ['Wheel to wheel', 'b'], ['Spin', 's'], ['Funny moment', 'f']]),
    game('Forza Horizon', [['Race win', 'w'], ['Big crash', 'c'], ['Big jump', 'j'], ['Drift', 'd'], ['Close finish', 'x'], ['Near miss', 'n'], ['Funny moment', 'f']]),
    game('General', [['Clip that', 'c'], ['Funny moment', 'f'], ['Big fail', 'x'], ['Clutch', 'v']]),
  ],
};

fs.mkdirSync(DATA, { recursive: true });
let cfg = fs.existsSync(CONFIG_FILE)
  ? { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }
  : DEFAULTS;

function save() {
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

// A range button saves two markers: the start and the end of a long event, for example a boss fight.
// Add one range button to each game one time. After that, Settings controls the range buttons.
const RANGE_LABELS = { 'Elden Ring': 'Boss fight', 'GTA 6': 'Mission', 'Helldivers 2': 'Mission', 'WRC': 'Stage', 'F1 25': 'Race', 'Forza Horizon': 'Race' };
if (!cfg.rangeButtons) {
  for (const g of cfg.games) {
    if (g.terms.some((t) => t.range)) continue;
    const key = g.terms.some((t) => t.key === '1') ? '' : '1';
    g.terms.unshift({ id: id(), label: RANGE_LABELS[g.name] || 'Segment', key, range: true });
  }
  cfg.rangeButtons = true;
}
save(); // keep the IDs of the default games the same after a restart

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- Session ----------

function parseVideoId(input) {
  const text = String(input || '').trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const match = url.pathname.match(/(?:^\/|\/live\/|\/video\/|\/embed\/|\/shorts\/)([\w-]{11})(?:\/|$)/);
    if (match) return match[1];
  } catch { /* not a URL */ }
  throw new HttpError(400, 'This is not a YouTube stream link.');
}

// Read the title and the start time of the stream from the public watch page. No API key is necessary.
async function readStreamPage(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`YouTube returned HTTP ${res.status}`);
  const html = await res.text();
  const live = html.match(/"liveBroadcastDetails":\{[^}]*\}/)?.[0] || '';
  const title = html.match(/<meta name="title" content="([^"]*)"/)?.[1];
  return {
    title: title ? title.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'") : null,
    isLiveNow: /"isLiveNow":true/.test(live),
    startTime: live.match(/"startTimestamp":"([^"]+)"/)?.[1] || null,
  };
}

async function startSession(input) {
  const now = new Date().toISOString();
  if (!String(input || '').trim()) {
    cfg.session = { id: `manual-${now.replace(/\D/g, '').slice(0, 14)}`, videoId: null, title: 'Session without a stream link', startTime: now, startSource: 'connect' };
    save();
    return { session: cfg.session };
  }
  const videoId = parseVideoId(input);
  let page = null, warning = null;
  try { page = await readStreamPage(videoId); } catch (e) { warning = `The app could not read the stream page (${e.message}).`; }
  if (page && !page.startTime) warning = 'The stream page shows no start time.';
  else if (page && !page.isLiveNow) warning = 'The stream is not live now.';
  const useStream = page?.startTime && page.isLiveNow;
  cfg.session = {
    id: videoId, videoId, title: page?.title || videoId,
    startTime: useStream ? new Date(page.startTime).toISOString() : now,
    startSource: useStream ? 'stream' : 'connect',
  };
  if (warning) warning += ' The clock starts now. Each marker also keeps the time of day.';
  save();
  return { session: cfg.session, warning };
}

// ---------- Markers ----------

function formatOffset(seconds) {
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function readMarkers(sessionId) {
  if (!fs.existsSync(MARKER_FILE)) return [];
  return fs.readFileSync(MARKER_FILE, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line)).filter((m) => !sessionId || m.sessionId === sessionId);
}

function writeMarkers(markers) {
  const tmp = MARKER_FILE + '.tmp';
  fs.writeFileSync(tmp, markers.map((m) => JSON.stringify(m) + '\n').join(''));
  fs.renameSync(tmp, MARKER_FILE);
}

// The start markers of the ranges that have no end marker.
function openRanges(sessionId) {
  const open = new Map();
  for (const m of readMarkers(sessionId)) {
    if (m.kind === 'start') open.set(m.rangeId, m);
    else if (m.kind === 'end') open.delete(m.rangeId);
  }
  return [...open.values()];
}

function newMarker(session, now, gameName, category, extra) {
  const offsetSec = Math.max(0, Math.round((now - Date.parse(session.startTime)) / 1000));
  return {
    id: id(), at: new Date(now).toISOString(), sessionId: session.id, videoId: session.videoId, title: session.title,
    game: gameName, category, offsetSec, offset: formatOffset(offsetSec), offsetFrom: session.startSource, ...extra,
  };
}

const endOf = (start, session, now) => {
  const end = newMarker(session, now, start.game, start.category, { kind: 'end', rangeId: start.rangeId, termId: start.termId });
  end.durationSec = Math.max(0, end.offsetSec - start.offsetSec);
  return end;
};

function stopSession() {
  const { session } = cfg;
  if (session) {
    const now = Date.now();
    for (const start of openRanges(session.id)) fs.appendFileSync(MARKER_FILE, JSON.stringify(endOf(start, session, now)) + '\n');
  }
  cfg.session = null;
  save();
  return {};
}

const lastMark = new Map(); // button id -> time of the last press

function mark(gameId, termId) {
  const now = Date.now();
  const g = cfg.games.find((x) => x.id === gameId);
  const button = g?.terms.find((t) => t.id === termId);
  if (!button) throw new HttpError(404, 'This button does not exist. Reload the page.');
  const { session } = cfg;
  if (!session) throw new HttpError(400, 'Start a session first.');
  if (now - (lastMark.get(termId) || 0) < COOLDOWN_MS) throw new HttpError(429, 'This button was saved a moment ago.');
  lastMark.set(termId, now);

  let marker;
  if (button.range) {
    // The first press starts the range. The second press ends it. Other buttons do not change it.
    const start = openRanges(session.id).find((m) => m.termId === termId);
    marker = start ? endOf(start, session, now) : newMarker(session, now, g.name, button.label, { kind: 'start', rangeId: id(), termId });
  } else {
    marker = newMarker(session, now, g.name, button.label);
  }
  fs.appendFileSync(MARKER_FILE, JSON.stringify(marker) + '\n');
  return marker;
}

function removeMarker(markerId) {
  const all = readMarkers();
  const target = all.find((m) => m.id === markerId);
  if (!target) throw new HttpError(404, 'This marker does not exist.');
  // A start marker goes together with its end marker. If only the end marker goes, the range is open again.
  const rest = all.filter((m) => (target.kind === 'start' ? m.rangeId !== target.rangeId : m.id !== markerId));
  writeMarkers(rest);
  return {};
}

function listSessions() {
  const sessions = new Map();
  for (const m of readMarkers()) {
    const s = sessions.get(m.sessionId) || { id: m.sessionId, videoId: m.videoId, first: m.at, count: 0, games: new Set() };
    s.count += 1;
    s.games.add(m.game);
    sessions.set(m.sessionId, s);
  }
  return [...sessions.values()].map((s) => ({ ...s, games: [...s.games] })).reverse();
}

// The export for the clip tool. `offsetSec` is the time into the stream, `at` is the time of day (UTC).
function exportSession(sessionId) {
  const all = readMarkers(sessionId);
  const markers = all.filter((m) => !m.kind);
  const ranges = all.filter((m) => m.kind === 'start').map((s) => {
    const e = all.find((m) => m.kind === 'end' && m.rangeId === s.rangeId);
    return {
      id: s.rangeId, game: s.game, category: s.category, offsetFrom: s.offsetFrom,
      startAt: s.at, startSec: s.offsetSec, start: s.offset,
      endAt: e?.at ?? null, endSec: e?.offsetSec ?? null, end: e?.offset ?? null, durationSec: e?.durationSec ?? null,
    };
  });
  const current = cfg.session?.id === sessionId ? cfg.session : null;
  const videoId = all[0]?.videoId ?? current?.videoId ?? null;
  return {
    sessionId, videoId, url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
    title: all[0]?.title ?? current?.title ?? null,
    ranges,
    markers: markers.map(({ id: markerId, at, game: g, category, offsetSec, offset, offsetFrom }) =>
      ({ id: markerId, at, game: g, category, offsetSec, offset, offsetFrom })),
  };
}

function exportCsv(sessionId) {
  const quote = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const rows = readMarkers(sessionId).map((m) =>
    [m.at, m.sessionId, m.videoId, m.offsetSec, m.offset, m.offsetFrom, m.game, m.category, m.kind || 'marker', m.rangeId].map(quote).join(','));
  return ['time_utc,session,video_id,offset_seconds,offset,offset_from,game,category,kind,range_id', ...rows].join('\n') + '\n';
}

function publicState() {
  return {
    games: cfg.games,
    session: cfg.session,
    markers: cfg.session ? readMarkers(cfg.session.id).slice(-50).reverse() : [],
    open: cfg.session ? Object.fromEntries(openRanges(cfg.session.id).map((m) => [m.termId, m])) : {},
    sessions: listSessions(),
  };
}

function cleanGames(games) {
  if (!Array.isArray(games)) throw new HttpError(400, 'The game list is not valid.');
  return games.map((g) => ({
    id: String(g.id || id()),
    name: String(g.name || '').trim().slice(0, 40) || 'Game',
    terms: (Array.isArray(g.terms) ? g.terms : [])
      .map((t) => ({
        id: String(t.id || id()),
        label: String(t.label || '').trim().slice(0, 60),
        key: String(t.key || '').trim().slice(0, 1).toLowerCase(),
        ...(t.range ? { range: true } : {}),
      }))
      .filter((t) => t.label),
  }));
}

// ---------- HTTP ----------

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) throw new HttpError(413, 'The request is too large.');
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'The request is not valid JSON.'); }
}

async function route(req, url) {
  const key = `${req.method} ${url.pathname}`;
  if (key === 'GET /api/state') return publicState();
  if (key === 'POST /api/mark') { const b = await readJson(req); return mark(b.gameId, b.termId); }
  if (key === 'DELETE /api/mark') return removeMarker(url.searchParams.get('id'));
  if (key === 'POST /api/session') return startSession((await readJson(req)).url);
  if (key === 'DELETE /api/session') return stopSession();
  if (key === 'PUT /api/games') { cfg.games = cleanGames((await readJson(req)).games); save(); return { games: cfg.games }; }
  throw new HttpError(404, 'Not found.');
}

function sendFile(res, type, name, body) {
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Content-Disposition': `attachment; filename="${name}"` });
  res.end(body);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    const sessionId = url.searchParams.get('session') || '';
    const safeName = sessionId.replace(/[^\w-]/g, '') || 'all';
    if (req.method === 'GET' && url.pathname === '/markers.json') {
      if (!sessionId) throw new HttpError(400, 'Give the session, for example /markers.json?session=<id>.');
      return sendFile(res, 'application/json', `markers-${safeName}.json`, JSON.stringify(exportSession(sessionId), null, 2));
    }
    if (req.method === 'GET' && url.pathname === '/markers.csv') return sendFile(res, 'text/csv', `markers-${safeName}.csv`, exportCsv(sessionId));
    const body = await route(req, url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  } catch (e) {
    res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, '0.0.0.0', () => console.log(`Clip Marker runs on http://0.0.0.0:${PORT}`));
