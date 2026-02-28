const fs = require('fs');
const path = require('path');
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  throw new Error('Missing dependency better-sqlite3. Run: npm install');
}

let db = null;

function init(dbPath = 'bot.sqlite') {
  db = new Database(dbPath);
  db.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, data TEXT)`).run();
}

function getAllUsers() {
  if (!db) throw new Error('DB not initialized');
  const rows = db.prepare('SELECT id, data FROM users').all();
  const out = {};
  for (const r of rows) {
    try { out[r.id] = JSON.parse(r.data); } catch (e) { out[r.id] = {}; }
  }
  return out;
}

function saveUser(id, obj) {
  if (!db) throw new Error('DB not initialized');
  db.prepare('INSERT OR REPLACE INTO users (id, data) VALUES (?, ?)').run(id, JSON.stringify(obj));
}

function saveAllUsers(usersObj) {
  if (!db) throw new Error('DB not initialized');
  const insert = db.prepare('INSERT OR REPLACE INTO users (id, data) VALUES (?, ?)');
  const entries = Object.entries(usersObj || {});
  const txn = db.transaction((rows) => { for (const [id, obj] of rows) insert.run(id, JSON.stringify(obj)); });
  txn(entries);
}

function migrateFromJson(jsonPath) {
  if (!fs.existsSync(jsonPath)) return;
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath));
    saveAllUsers(data);
    try { fs.renameSync(jsonPath, jsonPath + '.bak'); } catch (e) { /* ignore */ }
  } catch (e) {
    throw e;
  }
}

module.exports = { init, getAllUsers, saveUser, saveAllUsers, migrateFromJson };
