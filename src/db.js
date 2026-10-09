import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const file = process.env.DB_PATH || "data/city.db";
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new Database(file);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  trust REAL DEFAULT 0.5,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  lat REAL NOT NULL, lng REAL NOT NULL,
  category TEXT NOT NULL,
  severity INTEGER NOT NULL,
  summary TEXT NOT NULL,
  original_text TEXT,
  transcript TEXT,
  tags TEXT DEFAULT '[]',
  credibility REAL DEFAULT 0.5,
  photo TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_reports_geo ON reports(lat, lng);
CREATE TABLE IF NOT EXISTS confirmations (
  report_id INTEGER REFERENCES reports(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  PRIMARY KEY (report_id, user_id)
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  place_key TEXT NOT NULL,
  place_name TEXT,
  lat REAL, lng REAL,
  safety INTEGER, cleanliness INTEGER, affordability INTEGER, accessibility INTEGER,
  comment TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  UNIQUE(user_id, place_key)
);
`);
export default db;
