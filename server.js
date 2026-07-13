const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database ──────────────────────────────────────────────
const db = new Database('streakpact.db');

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token        TEXT UNIQUE NOT NULL,
    name         TEXT NOT NULL,
    color        TEXT NOT NULL DEFAULT '#7c6af7',
    invite_code  TEXT UNIQUE NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (date('now'))
  );

  CREATE TABLE IF NOT EXISTS habits (
    id          TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    emoji       TEXT NOT NULL DEFAULT '🎯',
    freq        TEXT NOT NULL DEFAULT 'daily',
    created_at  TEXT NOT NULL DEFAULT (date('now'))
  );

  CREATE TABLE IF NOT EXISTS completions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    habit_id  TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date      TEXT NOT NULL,
    UNIQUE(habit_id, date)
  );

  CREATE TABLE IF NOT EXISTS friendships (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, friend_id)
  );
`);

// ── Helpers ───────────────────────────────────────────────
function genInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return 'SP-' + c;
}

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function calcStreak(habitId, compMap) {
  let streak = 0;
  const d = new Date();
  const today = todayStr();
  while (true) {
    const key = d.toISOString().split('T')[0];
    const done = (compMap[key] || []).includes(habitId);
    if (!done) {
      // Today not done yet — still in progress, check yesterday
      if (key === today && streak === 0) { d.setDate(d.getDate() - 1); continue; }
      break;
    }
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function buildCompMap(rows) {
  const map = {};
  for (const r of rows) {
    if (!map[r.date]) map[r.date] = [];
    map[r.date].push(r.habit_id);
  }
  return map;
}

// ── Middleware ────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const token = req.headers['x-user-token'];
  if (!token) return res.status(401).json({ error: 'Missing token' });
  const user = db.prepare('SELECT * FROM users WHERE token = ?').get(token);
  if (!user) return res.status(401).json({ error: 'Unknown token — please set up your profile' });
  req.user = user;
  next();
}

// ── Profile ───────────────────────────────────────────────

// Upsert profile (register or update)
app.post('/api/profile', (req, res) => {
  const { token, name, color } = req.body;
  if (!token || !name) return res.status(400).json({ error: 'token and name required' });

  const existing = db.prepare('SELECT * FROM users WHERE token = ?').get(token);
  if (existing) {
    db.prepare('UPDATE users SET name = ?, color = ? WHERE token = ?')
      .run(name.trim(), color || existing.color, token);
  } else {
    let code = genInviteCode();
    while (db.prepare('SELECT id FROM users WHERE invite_code = ?').get(code)) code = genInviteCode();
    db.prepare('INSERT INTO users (token, name, color, invite_code) VALUES (?, ?, ?, ?)')
      .run(token, name.trim(), color || '#7c6af7', code);
  }
  res.json(db.prepare('SELECT id, name, color, invite_code, created_at FROM users WHERE token = ?').get(token));
});

app.get('/api/profile', auth, (req, res) => {
  const { id, name, color, invite_code, created_at } = req.user;
  res.json({ id, name, color, invite_code, created_at });
});

// ── Habits ────────────────────────────────────────────────
app.get('/api/habits', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM habits WHERE user_id = ? ORDER BY created_at').all(req.user.id));
});

app.post('/api/habits', auth, (req, res) => {
  const { name, emoji, freq } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const id = uid();
  db.prepare('INSERT INTO habits (id, user_id, name, emoji, freq) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, name.trim(), emoji || '🎯', freq || 'daily');
  res.status(201).json(db.prepare('SELECT * FROM habits WHERE id = ?').get(id));
});

app.delete('/api/habits/:id', auth, (req, res) => {
  const habit = db.prepare('SELECT * FROM habits WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!habit) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM habits WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Completions ───────────────────────────────────────────
app.get('/api/completions', auth, (req, res) => {
  const rows = db.prepare('SELECT habit_id, date FROM completions WHERE user_id = ?').all(req.user.id);
  res.json(buildCompMap(rows));
});

app.post('/api/completions/toggle', auth, (req, res) => {
  const { habitId } = req.body;
  if (!habitId) return res.status(400).json({ error: 'habitId required' });

  const habit = db.prepare('SELECT * FROM habits WHERE id = ? AND user_id = ?').get(habitId, req.user.id);
  if (!habit) return res.status(404).json({ error: 'Habit not found' });

  const date = todayStr();
  const existing = db.prepare('SELECT id FROM completions WHERE habit_id = ? AND date = ?').get(habitId, date);
  if (existing) {
    db.prepare('DELETE FROM completions WHERE habit_id = ? AND date = ?').run(habitId, date);
    res.json({ done: false });
  } else {
    db.prepare('INSERT INTO completions (habit_id, user_id, date) VALUES (?, ?, ?)').run(habitId, req.user.id, date);
    res.json({ done: true });
  }
});

// ── Friends ───────────────────────────────────────────────
app.get('/api/friends', auth, (req, res) => {
  const friendUsers = db.prepare(`
    SELECT u.id, u.name, u.color, u.invite_code
    FROM friendships f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ?
    ORDER BY f.created_at
  `).all(req.user.id);

  const result = friendUsers.map(friend => {
    const habits = db.prepare('SELECT * FROM habits WHERE user_id = ? ORDER BY created_at').all(friend.id);
    const compRows = db.prepare('SELECT habit_id, date FROM completions WHERE user_id = ?').all(friend.id);
    const compMap = buildCompMap(compRows);
    const today = todayStr();

    return {
      ...friend,
      habits: habits.map(h => ({
        id: h.id,
        name: h.name,
        emoji: h.emoji,
        streak: calcStreak(h.id, compMap),
        doneToday: (compMap[today] || []).includes(h.id)
      }))
    };
  });

  res.json(result);
});

app.post('/api/friends', auth, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  const friend = db.prepare('SELECT * FROM users WHERE invite_code = ?').get(code.toUpperCase());
  if (!friend) return res.status(404).json({ error: 'No user found with that invite code' });
  if (friend.id === req.user.id) return res.status(400).json({ error: 'You cannot add yourself' });

  const existing = db.prepare('SELECT id FROM friendships WHERE user_id = ? AND friend_id = ?')
    .get(req.user.id, friend.id);
  if (existing) return res.status(400).json({ error: 'Already friends with this person' });

  // Add both directions so it's mutual
  db.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)').run(req.user.id, friend.id);
  db.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)').run(friend.id, req.user.id);

  res.status(201).json({ ok: true, name: friend.name });
});

app.delete('/api/friends/:code', auth, (req, res) => {
  const friend = db.prepare('SELECT * FROM users WHERE invite_code = ?').get(req.params.code);
  if (!friend) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM friendships WHERE user_id = ? AND friend_id = ?').run(req.user.id, friend.id);
  db.prepare('DELETE FROM friendships WHERE user_id = ? AND friend_id = ?').run(friend.id, req.user.id);
  res.json({ ok: true });
});

// ── Stats ─────────────────────────────────────────────────
app.get('/api/stats', auth, (req, res) => {
  const habits = db.prepare('SELECT * FROM habits WHERE user_id = ?').all(req.user.id);
  const compRows = db.prepare('SELECT habit_id, date FROM completions WHERE user_id = ?').all(req.user.id);
  const compMap = buildCompMap(compRows);
  const allDays = Object.keys(compMap);

  const habitsWithStats = habits.map(h => ({
    ...h,
    streak: calcStreak(h.id, compMap),
    total: compRows.filter(c => c.habit_id === h.id).length
  }));

  const perfectDays = allDays.filter(d =>
    habits.length > 0 && habits.every(h => (compMap[d] || []).includes(h.id))
  ).length;

  res.json({
    habits: habitsWithStats,
    completions: compMap,
    totalCheckins: compRows.length,
    perfectDays,
    longestStreak: habitsWithStats.length
      ? Math.max(...habitsWithStats.map(h => h.streak), 0)
      : 0
  });
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`StreakPact running on http://0.0.0.0:${PORT}`);
});
