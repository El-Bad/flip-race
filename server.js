// Flip Race — multiplayer server. No dependencies: plain Node http.
// Live updates use long-polling (works through Cloudflare tunnels and other proxies,
// which buffer Server-Sent Events).
// Run: node server.js   (then open http://localhost:3000)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MIN_SIZE = 3, MAX_SIZE = 10;
const COUNTDOWN_MS = 3000;
const EARLY_CLICK_GRACE_MS = 300;
const MIN_OPTIMAL_CLICKS = 2;      // only boards needing at least this many clicks
const POLL_TIMEOUT_MS = 25000;     // how long a poll waits for news before answering anyway
const OFFLINE_AFTER_MS = 6000;     // no poll for this long = shown as offline
const DISCONNECT_GRACE_MS = 20000; // offline this long = removed from the room
const MAX_NAME = 20;
const MAX_HISTORY = 10;

// Stars: 1st = 10, 2nd = 5, everyone else in the round = 1 (if they made a click).
// Kept in memory only: they reset when you leave the room or the server restarts.
const POINTS_FIRST = 10, POINTS_SECOND = 5, POINTS_OTHER = 1;

// Theme shop (the looks are defined in public/index.html). A tier is unlocked once your
// best solve time is under its limit; then each theme in it can be bought with stars.
const TIERS = {
  free:      { price: 0,   unlockMs: null },
  basic:     { price: 10,  unlockMs: 25000 },
  medium:    { price: 25,  unlockMs: 15000 },
  legendary: { price: 50,  unlockMs: 5000 }
};
const THEME_TIERS = {
  classic: 'free',
  ocean: 'basic', sunset: 'basic', mono: 'basic', candy: 'basic',
  lime: 'basic', grape: 'basic', ember: 'basic', slate: 'basic',
  retro: 'medium', forest: 'medium', bubble: 'medium', marble: 'medium',
  circuit: 'medium', denim: 'medium', checker: 'medium', ice: 'medium',
  galaxy: 'legendary', lava: 'legendary', holo: 'legendary', royal: 'legendary',
  neon: 'legendary', aurora: 'legendary', plasma: 'legendary', matrix: 'legendary'
};
const MIN_PLAYERS_FOR_RECORD = 2;  // wins/losses only count in races with 2+ players

// ---------------------------------------------------------------- persistent profiles
// A profile keeps career stats and the best time (and the board) per grid size. Skin
// progress (unlocked tiers, owned themes, stars) is NOT saved: it starts fresh in each
// lobby. The profile is stored on the server (data/profiles.json) AND given to the
// browser as an AES-256-GCM sealed blob. GCM is authenticated, so any edit to the blob
// makes it fail to open: players can't fake times or unlocks. When both copies exist,
// the newer one wins (so replaying an old blob can't erase losses).
const DATA_DIR = path.join(__dirname, 'data');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');

function loadOrCreateKey() {
  if (process.env.PROFILE_SECRET)  // set this when hosting so the key survives redeploys
    return crypto.createHash('sha256').update(process.env.PROFILE_SECRET).digest();
  const f = path.join(DATA_DIR, 'secret.key');
  try {
    const k = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
    if (k.length === 32) return k;
  } catch { /* create below */ }
  const k = crypto.randomBytes(32);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(f, k.toString('hex'), { mode: 0o600 });
  return k;
}
const SECRET = loadOrCreateKey();

function sealProfile(profile) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(profile), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

function openProfile(blob) {
  try {
    const b = Buffer.from(String(blob), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', SECRET, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
  } catch {
    return null;   // tampered, corrupt, or sealed with a different key
  }
}

function newProfile() {
  return { id: crypto.randomBytes(12).toString('hex'), ...emptyStats(),
           best: {}, updatedAt: Date.now() };
}

// Numeric career stats
const STAT_KEYS = ['wins', 'losses', 'races', 'seconds', 'streak', 'bestStreak',
                   'solves', 'perfectSolves', 'totalClicks', 'totalSolveMs', 'starsEarned'];
function emptyStats() { return Object.fromEntries(STAT_KEYS.map(k => [k, 0])); }

// Clean up anything loaded from disk or a blob into the expected shape
function normalizeProfile(raw) {
  if (!raw || typeof raw.id !== 'string') return null;
  const p = newProfile();
  p.id = raw.id;
  for (const k of [...STAT_KEYS, 'updatedAt']) if (Number.isFinite(raw[k])) p[k] = raw[k];
  if (raw.best && typeof raw.best === 'object') p.best = raw.best;
  return p;
}

const profiles = new Map();   // id -> profile
try {
  for (const raw of Object.values(JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')))) {
    const p = normalizeProfile(raw);
    if (p) profiles.set(p.id, p);
  }
} catch { /* no saved profiles yet */ }

let saveTimer = null;
function saveProfiles() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFile(PROFILES_FILE + '.tmp', JSON.stringify(Object.fromEntries(profiles)), err => {
      if (!err) fs.rename(PROFILES_FILE + '.tmp', PROFILES_FILE, () => {});
    });
  }, 500);
}

function touchProfile(p) {
  p.updatedAt = Date.now();
  saveProfiles();
}

// On join: open the browser's blob, compare with the server copy, keep the newer one
function profileForJoin(blob) {
  const fromBlob = blob ? normalizeProfile(openProfile(blob)) : null;
  if (fromBlob) {
    const onServer = profiles.get(fromBlob.id);
    if (onServer && onServer.updatedAt >= fromBlob.updatedAt) return onServer;
    profiles.set(fromBlob.id, fromBlob);
    saveProfiles();
    return fromBlob;
  }
  const p = newProfile();
  profiles.set(p.id, p);
  saveProfiles();
  return p;
}

const overallBest = p => {
  const times = Object.values(p.best).map(b => b.ms).filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
};
// Skin progress lives on the player in this lobby (resets when you join a new one)
const tierUnlocked = (tier, player) => player.unlocked.includes(tier);
function unlockTiers(player, ms) {
  for (const [tier, { unlockMs }] of Object.entries(TIERS))
    if (unlockMs !== null && ms < unlockMs && !player.unlocked.includes(tier)) player.unlocked.push(tier);
}

// Record a solve in the saved profile: stats and best time per grid size (with the board)
function recordSolve(profile, round, ms, clicks) {
  profile.solves++;
  profile.totalClicks += clicks;
  profile.totalSolveMs += ms;
  if (clicks === round.optimal) profile.perfectSolves++;
  const key = String(round.size);
  const prev = profile.best[key];
  if (!prev || ms < prev.ms) {
    profile.best[key] = {
      ms, board: round.board.join(''), obstacles: round.obstacles,
      blocked: round.blocked ? round.blocked.flatMap((b, i) => b ? [i] : []) : [], at: Date.now()
    };
  }
  touchProfile(profile);
}

// What the player sees about their own profile
const profileView = p => ({
  ...Object.fromEntries(STAT_KEYS.map(k => [k, p[k]])), best: p.best, bestMs: overallBest(p)
});

// Obstacles: blocked squares that can't be clicked and never flip. At most a quarter of the board.
const maxObstacles = n => Math.floor(n * n / 4);

// ---------------------------------------------------------------- game logic
// Clicking a square flips it and its up/down/left/right neighbours, except blocked squares.
// Solved = every open square green (0). `blocked` is an array of booleans (or null).

function flipCells(n, i, blocked) {
  const r = Math.floor(i / n), c = i % n, out = [i];
  if (r > 0) out.push(i - n);
  if (r < n - 1) out.push(i + n);
  if (c > 0) out.push(i - 1);
  if (c < n - 1) out.push(i + 1);
  return blocked ? out.filter(j => !blocked[j]) : out;
}

function applyClick(n, board, i, blocked) {
  for (const j of flipCells(n, i, blocked)) board[j] ^= 1;
}

const popcount = v => { let c = 0; while (v) { c += Number(v & 1n); v >>= 1n; } return c; };

// Fewest clicks to turn `board` all green, via Gaussian elimination over GF(2).
// Some sizes (4, 5, 9...) have several solutions per board; we enumerate them all and keep
// the smallest. Blocked squares can't be clicked. Returns { count, clicks } or null.
function minSolution(n, board, blocked) {
  const N = n * n, AUG = 1n << BigInt(N);
  const rows = [];
  for (let i = 0; i < N; i++) {
    let m = 0n;
    if (blocked && blocked[i]) {
      m = 1n << BigInt(i);                     // equation: "don't click a blocked square"
    } else {
      for (const j of flipCells(n, i, blocked)) m |= 1n << BigInt(j); // open clicks j that flip cell i
      if (board[i]) m |= AUG;
    }
    rows.push(m);
  }
  const pivots = [];
  let r = 0;
  for (let c = 0; c < N && r < N; c++) {
    const bit = 1n << BigInt(c);
    let p = -1;
    for (let k = r; k < N; k++) if (rows[k] & bit) { p = k; break; }
    if (p < 0) continue;
    [rows[r], rows[p]] = [rows[p], rows[r]];
    for (let k = 0; k < N; k++) if (k !== r && (rows[k] & bit)) rows[k] ^= rows[r];
    pivots.push(c);
    r++;
  }
  for (let k = r; k < N; k++) if (rows[k] & AUG) return null;

  const isPivot = new Set(pivots);
  let best = 0n;
  pivots.forEach((c, k) => { if (rows[k] & AUG) best |= 1n << BigInt(c); });
  const basis = [];
  for (let f = 0; f < N; f++) if (!isPivot.has(f)) {
    let v = 1n << BigInt(f);
    const fb = 1n << BigInt(f);
    pivots.forEach((c, k) => { if (rows[k] & fb) v |= 1n << BigInt(c); });
    basis.push(v);
  }
  if (basis.length > 20) basis.length = 20; // safety cap; never reached for sizes <= 10
  let bestW = popcount(best);
  const base = best;
  for (let m = 1; m < (1 << basis.length); m++) {
    let v = base;
    for (let k = 0; k < basis.length; k++) if (m >> k & 1) v ^= basis[k];
    const w = popcount(v);
    if (w < bestW) { best = v; bestW = w; }
  }
  const clicks = [];
  for (let i = 0; i < N; i++) if (best >> BigInt(i) & 1n) clicks.push(i);
  return { count: bestW, clicks };
}

function randomBlocked(n, k) {
  const idx = [...Array(n * n).keys()];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const blocked = new Array(n * n).fill(false);
  idx.slice(0, k).forEach(i => blocked[i] = true);
  return blocked;
}

// Random solvable board needing at least MIN_OPTIMAL_CLICKS clicks, with `obstacles` blocked
// squares. Built by applying random clicks to an all-green board, so it is always solvable.
function generateBoard(n, obstacles = 0) {
  obstacles = Math.max(0, Math.min(maxObstacles(n), obstacles | 0));
  for (;;) {
    const blocked = obstacles ? randomBlocked(n, obstacles) : null;
    for (let attempt = 0; attempt < 100; attempt++) {
      const board = new Array(n * n).fill(0);
      for (let i = 0; i < n * n; i++)
        if (!(blocked && blocked[i]) && Math.random() < 0.5) applyClick(n, board, i, blocked);
      const sol = minSolution(n, board, blocked);
      if (sol && sol.count >= MIN_OPTIMAL_CLICKS)
        return { board, blocked, optimal: sol.count, solution: sol.clicks };
    }
    // This obstacle layout makes good boards too rare; try another layout
  }
}

// ---------------------------------------------------------------- rooms
const rooms = new Map();   // code -> room
const tokens = new Map();  // secret token -> { room, playerId }

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newRoomCode() {
  let code;
  do { code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: newRoomCode(), size: 3, obstacles: 0, hostId: null,
    players: new Map(), waiters: new Set(), version: 0,
    round: null, roundCounter: 0, history: []
  };
  rooms.set(room.code, room);
  return room;
}

function uniqueName(room, name) {
  const taken = new Set([...room.players.values()].map(p => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let k = 2; ; k++) if (!taken.has(`${name} (${k})`.toLowerCase())) return `${name} (${k})`;
}

function addPlayer(room, name, profile) {
  const id = crypto.randomBytes(6).toString('hex');
  const token = crypto.randomBytes(16).toString('hex');
  const player = {
    id, token, name: uniqueName(room, name), wins: 0, points: 0, profile,
    unlocked: ['free'], owned: ['classic'], theme: 'classic', lobbyBestMs: null,
    board: null, clicks: 0, finishMs: null,
    online: true, lastSeen: Date.now(), waiting: 0, joinedAt: Date.now()
  };
  if (room.round) resetPlayerForRound(player, room.round);
  room.players.set(id, player);
  tokens.set(token, { room, playerId: id });
  if (!room.hostId) room.hostId = id;
  return player;
}

function removePlayer(room, id) {
  const p = room.players.get(id);
  if (!p) return;
  tokens.delete(p.token);
  // Keep leavers in this round's results (as DNF, or with their time)
  if (room.round && room.round.status !== 'finished') {
    room.round.leavers.push({ name: p.name, ms: p.finishMs, clicks: p.clicks, pts: 0 });
    // Quitting a multiplayer race you were playing (and hadn't finished) counts as a loss
    if (p.clicks > 0 && p.finishMs === null && room.players.size >= MIN_PLAYERS_FOR_RECORD) {
      p.profile.losses++;
      p.profile.races++;
      p.profile.streak = 0;
      touchProfile(p.profile);
    }
  }
  room.players.delete(id);
  if (room.players.size === 0) {
    for (const w of room.waiters) { clearTimeout(w.timer); w.res.end(); }
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === id) {
    const next = [...room.players.values()].sort((a, b) => b.online - a.online || a.joinedAt - b.joinedAt)[0];
    room.hostId = next.id;
  }
  checkRoundOver(room);
  broadcast(room);
}

function resetPlayerForRound(player, round) {
  player.board = [...round.board];
  player.clicks = 0;
  player.finishMs = null;
}

function startRound(room, size, obstacles) {
  // Starting a new race ends the current one (and awards its points)
  if (room.round && room.round.status !== 'finished') finishRound(room);
  room.size = Math.max(MIN_SIZE, Math.min(MAX_SIZE, size | 0 || room.size));
  room.obstacles = Math.max(0, Math.min(maxObstacles(room.size), obstacles | 0));
  const { board, blocked, optimal, solution } = generateBoard(room.size, room.obstacles);
  const round = {
    id: ++room.roundCounter, size: room.size, board, blocked, optimal, solution,
    obstacles: room.obstacles,
    startAt: Date.now() + COUNTDOWN_MS, status: 'countdown', winnerId: null, leavers: []
  };
  room.round = round;
  for (const p of room.players.values()) resetPlayerForRound(p, round);
  setTimeout(() => {
    if (room.round === round && round.status === 'countdown') { round.status = 'racing'; broadcast(room); }
  }, COUNTDOWN_MS);
  broadcast(room);
}

function checkRoundOver(room) {
  const round = room.round;
  if (!round || round.status === 'finished') return;
  const active = [...room.players.values()].filter(p => p.online);
  if (active.length && active.every(p => p.finishMs !== null)) finishRound(room);
}

function finishRound(room) {
  const round = room.round;
  round.status = 'finished';

  // Award stars
  const players = [...room.players.values()];
  const finishers = players.filter(p => p.finishMs !== null).sort((a, b) => a.finishMs - b.finishMs);
  round.awards = {};
  for (const p of players) {
    const rank = finishers.indexOf(p);
    const pts = rank === 0 ? POINTS_FIRST : rank === 1 ? POINTS_SECOND : p.clicks > 0 ? POINTS_OTHER : 0;
    p.points += pts;
    p.profile.starsEarned += pts;
    round.awards[p.id] = pts;
    if (pts) touchProfile(p.profile);
  }

  // Career record (multiplayer races only; you must have played)
  if (players.length + round.leavers.length >= MIN_PLAYERS_FOR_RECORD) {
    for (const p of players) {
      if (p.clicks === 0) continue;
      const pr = p.profile;
      pr.races++;
      if (finishers[0] === p) {
        pr.wins++;
        pr.streak++;
        pr.bestStreak = Math.max(pr.bestStreak, pr.streak);
      } else {
        pr.losses++;
        pr.streak = 0;
        if (finishers[1] === p) pr.seconds++;
      }
      touchProfile(pr);
    }
  }

  const results = players
    .map(p => ({ name: p.name, ms: p.finishMs, clicks: p.clicks, pts: round.awards[p.id] }))
    .concat(round.leavers)
    .sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity));
  room.history.unshift({ round: round.id, size: round.size, obstacles: round.obstacles, optimal: round.optimal, results });
  room.history.length = Math.min(room.history.length, MAX_HISTORY);
}

function handleClick(room, player, cell, roundId) {
  const round = room.round;
  if (!round || round.id !== roundId) return 'Round has changed';
  // Small grace window: a click sent right as "go" appears may arrive a moment early
  // because each browser's clock estimate is slightly off.
  if (Date.now() < round.startAt - EARLY_CLICK_GRACE_MS) return 'Race has not started';
  if (round.status === 'finished') return 'Round is over';
  if (player.finishMs !== null) return 'Already finished';
  if (!Number.isInteger(cell) || cell < 0 || cell >= round.size * round.size) return 'Bad cell';
  if (round.blocked && round.blocked[cell]) return 'That square is blocked';
  if (round.status === 'countdown') round.status = 'racing';
  applyClick(round.size, player.board, cell, round.blocked);
  player.clicks++;
  if (player.board.every(v => v === 0)) {
    player.finishMs = Math.max(0, Date.now() - round.startAt);
    recordSolve(player.profile, round, player.finishMs, player.clicks);
    unlockTiers(player, player.finishMs);
    if (player.lobbyBestMs === null || player.finishMs < player.lobbyBestMs) player.lobbyBestMs = player.finishMs;
    if (!round.winnerId) { round.winnerId = player.id; player.wins++; }
    checkRoundOver(room);
  }
  broadcast(room);
  return null;
}

// Everything the browser needs. The solution stays secret until the round is over.
function publicState(room) {
  const r = room.round;
  return {
    version: room.version,
    code: room.code, hostId: room.hostId, size: room.size, obstacles: room.obstacles,
    serverNow: Date.now(), minSize: MIN_SIZE, maxSize: MAX_SIZE,
    tiers: TIERS, themeTiers: THEME_TIERS,
    round: r && {
      id: r.id, size: r.size, board: r.board.join(''), startAt: r.startAt,
      blocked: r.blocked ? r.blocked.flatMap((b, i) => b ? [i] : []) : [],
      status: r.status, winnerId: r.winnerId,
      awards: r.awards || null,
      optimal: r.status === 'finished' ? r.optimal : null,
      solution: r.status === 'finished' ? r.solution : null
    },
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, wins: p.wins, online: p.online,
      board: p.board ? p.board.join('') : null, clicks: p.clicks, finishMs: p.finishMs,
      points: p.points, theme: p.theme, unlocked: p.unlocked, owned: p.owned,
      lobbyBestMs: p.lobbyBestMs, bestMs: overallBest(p.profile),
      careerWins: p.profile.wins, careerLosses: p.profile.losses
    })),
    history: room.history
  };
}

// ---------------------------------------------------------------- long-polling
// Each poll answer = the shared room state + that player's own profile (readable view
// and the sealed blob their browser saves).
function pollBody(sharedJSON, player) {
  const you = { profile: profileView(player.profile), blob: sealProfile(player.profile) };
  return `{"state":${sharedJSON},"you":${JSON.stringify(you)}}`;
}

function sendPoll(res, sharedJSON, player) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(pollBody(sharedJSON, player));
}

function answerWaiter(w, sharedJSON) {
  clearTimeout(w.timer);
  w.room.waiters.delete(w);
  w.player.waiting--;
  w.player.lastSeen = Date.now();
  sendPoll(w.res, sharedJSON, w.player);
}

// Something changed: bump the version and answer everyone who is waiting.
function broadcast(room) {
  room.version++;
  const shared = JSON.stringify(publicState(room));
  for (const w of [...room.waiters]) answerWaiter(w, shared);
}

function handlePoll(req, res, url) {
  const t = tokens.get(url.searchParams.get('token'));
  if (!t) return sendJSON(res, 404, { error: 'Unknown player' });
  const { room, playerId } = t;
  const player = room.players.get(playerId);
  player.lastSeen = Date.now();
  if (!player.online) { player.online = true; broadcast(room); }

  const since = Number(url.searchParams.get('v'));
  if (!(since >= room.version))   // client is behind (or brand new): answer right away
    return sendPoll(res, JSON.stringify(publicState(room)), player);
  const w = { res, room, player, timer: null };
  w.timer = setTimeout(() => answerWaiter(w, JSON.stringify(publicState(room))), POLL_TIMEOUT_MS);
  room.waiters.add(w);
  player.waiting++;
  req.on('close', () => {
    if (!room.waiters.has(w)) return;
    clearTimeout(w.timer);
    room.waiters.delete(w);
    player.waiting--;
    player.lastSeen = Date.now();
  });
}

// Mark players offline / remove them when they stop polling
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    let changed = false;
    for (const p of [...room.players.values()]) {
      if (p.waiting > 0) continue;
      if (p.online && now - p.lastSeen > OFFLINE_AFTER_MS) { p.online = false; changed = true; }
      if (!p.online && now - p.lastSeen > DISCONNECT_GRACE_MS) { removePlayer(room, p.id); changed = false; }
    }
    if (changed && rooms.has(room.code)) { checkRoundOver(room); broadcast(room); }
  }
}, 2000).unref();

// ---------------------------------------------------------------- http
function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10000) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
  });
}

const INDEX = path.join(__dirname, 'public', 'index.html');

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(INDEX).pipe(res);
  }

  if (req.method === 'GET' && url.pathname === '/api/poll') return handlePoll(req, res, url);

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    let body;
    try { body = await readJSON(req); } catch { return sendJSON(res, 400, { error: 'Bad request' }); }
    const action = url.pathname.slice(5);

    if (action === 'join') {
      const name = String(body.name || '').trim().slice(0, MAX_NAME) || 'Player';
      const code = String(body.room || '').trim().toUpperCase();
      let room;
      if (code) {
        room = rooms.get(code);
        if (!room) return sendJSON(res, 404, { error: `Room ${code} not found` });
      } else {
        room = createRoom();
      }
      const p = addPlayer(room, name, profileForJoin(body.profile));
      broadcast(room);
      return sendJSON(res, 200, { token: p.token, id: p.id, room: room.code, name: p.name });
    }

    const t = tokens.get(body.token);
    if (!t) return sendJSON(res, 404, { error: 'Unknown player' });
    const { room, playerId } = t;
    const player = room.players.get(playerId);
    player.lastSeen = Date.now();

    if (action === 'start') {
      if (room.hostId !== playerId) return sendJSON(res, 403, { error: 'Only the host can start' });
      startRound(room, Number(body.size), Number(body.obstacles));
      return sendJSON(res, 200, { ok: true });
    }
    if (action === 'click') {
      const err = handleClick(room, player, body.cell, body.roundId);
      return sendJSON(res, err ? 409 : 200, err ? { error: err } : { ok: true });
    }
    if (action === 'buy' || action === 'equip') {
      const theme = String(body.theme);
      const tier = THEME_TIERS[theme];
      if (!tier) return sendJSON(res, 400, { error: 'Unknown theme' });
      if (action === 'buy') {
        const { price, unlockMs } = TIERS[tier];
        if (player.owned.includes(theme)) return sendJSON(res, 409, { error: 'You already own this theme' });
        if (!tierUnlocked(tier, player))
          return sendJSON(res, 403, { error: `Solve a board in under ${unlockMs / 1000}s to unlock this tier` });
        if (player.points < price) return sendJSON(res, 409, { error: `Not enough stars (need ${price})` });
        player.points -= price;
        player.owned.push(theme);
      } else if (!player.owned.includes(theme)) {
        return sendJSON(res, 403, { error: "You don't own this theme" });
      }
      player.theme = theme;   // buying also equips it
      broadcast(room);
      return sendJSON(res, 200, { ok: true });
    }
    if (action === 'leave') {
      removePlayer(room, playerId);
      return sendJSON(res, 200, { ok: true });
    }
  }

  sendJSON(res, 404, { error: 'Not found' });
}

if (require.main === module) {
  http.createServer((req, res) => handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) sendJSON(res, 500, { error: 'Server error' });
  })).listen(PORT, () => {
    console.log(`Flip Race running on http://localhost:${PORT}`);
    const nets = require('os').networkInterfaces();
    for (const list of Object.values(nets))
      for (const a of list) if (a.family === 'IPv4' && !a.internal)
        console.log(`  On your network: http://${a.address}:${PORT}`);
  });
}

module.exports = { minSolution, generateBoard, applyClick, flipCells, maxObstacles };
