const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'streakpact.json');

// ── JSON File Database ────────────────────────────────────
// Schema: { users, habits, completions, friendships }

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { users: [], habits: [], completions: [], friendships: [] }; }
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDB();

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

function buildCompMap(completions) {
  const map = {};
  for (const c of completions) {
    if (!map[c.date]) map[c.date] = [];
    map[c.date].push(c.habit_id);
  }
  return map;
}

function calcStreak(habitId, compMap) {
  let streak = 0;
  const d = new Date();
  const today = todayStr();
  while (true) {
    const key = d.toISOString().split('T')[0];
    const done = (compMap[key] || []).includes(habitId);
    if (!done) {
      if (key === today && streak === 0) { d.setDate(d.getDate() - 1); continue; }
      break;
    }
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

// ── Middleware ────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const token = req.headers['x-user-token'];
  if (!token) return res.status(401).json({ error: 'Missing token' });
  const user = db.users.find(u => u.token === token);
  if (!user) return res.status(401).json({ error: 'Unknown token — please set up your profile' });
  req.user = user;
  next();
}

// ── Profile ───────────────────────────────────────────────

app.post('/api/profile', (req, res) => {
  const { token, name, color } = req.body;
  if (!token || !name) return res.status(400).json({ error: 'token and name required' });

  let user = db.users.find(u => u.token === token);
  if (user) {
    user.name = name.trim();
    if (color) user.color = color;
  } else {
    let invite_code = genInviteCode();
    while (db.users.find(u => u.invite_code === invite_code)) invite_code = genInviteCode();
    user = { id: uid(), token, name: name.trim(), color: color || '#7c6af7', invite_code, created_at: todayStr() };
    db.users.push(user);
  }
  saveDB();
  const { token: _, ...safe } = user;
  res.json(safe);
});

app.get('/api/profile', auth, (req, res) => {
  const { token: _, ...safe } = req.user;
  res.json(safe);
});

// ── Habits ────────────────────────────────────────────────

app.get('/api/habits', auth, (req, res) => {
  res.json(db.habits.filter(h => h.user_id === req.user.id));
});

app.post('/api/habits', auth, (req, res) => {
  const { name, emoji, freq } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const habit = { id: uid(), user_id: req.user.id, name: name.trim(), emoji: emoji || '🎯', freq: freq || 'daily', created_at: todayStr() };
  db.habits.push(habit);
  saveDB();
  res.status(201).json(habit);
});

app.delete('/api/habits/:id', auth, (req, res) => {
  const idx = db.habits.findIndex(h => h.id === req.params.id && h.user_id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.habits.splice(idx, 1);
  db.completions = db.completions.filter(c => c.habit_id !== req.params.id);
  saveDB();
  res.json({ ok: true });
});

// ── Completions ───────────────────────────────────────────

app.get('/api/completions', auth, (req, res) => {
  res.json(buildCompMap(db.completions.filter(c => c.user_id === req.user.id)));
});

app.post('/api/completions/toggle', auth, (req, res) => {
  const { habitId } = req.body;
  if (!habitId) return res.status(400).json({ error: 'habitId required' });
  if (!db.habits.find(h => h.id === habitId && h.user_id === req.user.id))
    return res.status(404).json({ error: 'Habit not found' });

  const date = todayStr();
  const idx = db.completions.findIndex(c => c.habit_id === habitId && c.date === date);
  if (idx !== -1) {
    db.completions.splice(idx, 1);
    saveDB();
    return res.json({ done: false });
  }
  db.completions.push({ habit_id: habitId, user_id: req.user.id, date });
  saveDB();
  res.json({ done: true });
});

// ── Friends ───────────────────────────────────────────────

app.get('/api/friends', auth, (req, res) => {
  const friendIds = db.friendships
    .filter(f => f.user_id === req.user.id)
    .map(f => f.friend_id);

  const result = friendIds.map(fid => {
    const friend = db.users.find(u => u.id === fid);
    if (!friend) return null;
    const habits = db.habits.filter(h => h.user_id === fid);
    const compMap = buildCompMap(db.completions.filter(c => c.user_id === fid));
    const today = todayStr();
    return {
      id: friend.id,
      name: friend.name,
      color: friend.color,
      invite_code: friend.invite_code,
      habits: habits.map(h => ({
        id: h.id, name: h.name, emoji: h.emoji,
        streak: calcStreak(h.id, compMap),
        doneToday: (compMap[today] || []).includes(h.id)
      }))
    };
  }).filter(Boolean);

  res.json(result);
});

app.post('/api/friends', auth, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  const friend = db.users.find(u => u.invite_code === code.toUpperCase());
  if (!friend) return res.status(404).json({ error: 'No user found with that invite code' });
  if (friend.id === req.user.id) return res.status(400).json({ error: 'You cannot add yourself' });
  if (db.friendships.find(f => f.user_id === req.user.id && f.friend_id === friend.id))
    return res.status(400).json({ error: 'Already friends with this person' });

  // Mutual friendship
  db.friendships.push({ user_id: req.user.id, friend_id: friend.id });
  if (!db.friendships.find(f => f.user_id === friend.id && f.friend_id === req.user.id))
    db.friendships.push({ user_id: friend.id, friend_id: req.user.id });

  saveDB();
  res.status(201).json({ ok: true, name: friend.name });
});

app.delete('/api/friends/:code', auth, (req, res) => {
  const friend = db.users.find(u => u.invite_code === req.params.code);
  if (!friend) return res.status(404).json({ error: 'Not found' });
  db.friendships = db.friendships.filter(
    f => !(f.user_id === req.user.id && f.friend_id === friend.id) &&
         !(f.user_id === friend.id && f.friend_id === req.user.id)
  );
  saveDB();
  res.json({ ok: true });
});

// ── Stats ─────────────────────────────────────────────────

app.get('/api/stats', auth, (req, res) => {
  const habits = db.habits.filter(h => h.user_id === req.user.id);
  const userComps = db.completions.filter(c => c.user_id === req.user.id);
  const compMap = buildCompMap(userComps);
  const allDays = Object.keys(compMap);

  const habitsWithStats = habits.map(h => ({
    ...h,
    streak: calcStreak(h.id, compMap),
    total: userComps.filter(c => c.habit_id === h.id).length
  }));

  const perfectDays = allDays.filter(d =>
    habits.length > 0 && habits.every(h => (compMap[d] || []).includes(h.id))
  ).length;

  res.json({
    habits: habitsWithStats,
    completions: compMap,
    totalCheckins: userComps.length,
    perfectDays,
    longestStreak: habitsWithStats.length ? Math.max(...habitsWithStats.map(h => h.streak), 0) : 0
  });
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`StreakPact running on http://0.0.0.0:${PORT}`);
});
