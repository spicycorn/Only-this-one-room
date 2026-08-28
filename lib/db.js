// 只此一间 · 数据层（node:sqlite，插件即应用的核心存储）。
// 单文件 SQLite，落在稳定数据目录（默认 ~/.dsh/only-room/，可被 ONLY_ROOM_DATA_DIR 或 config.dataDir 覆盖）。
// 若旧 Python 后端的 ~/.only-room/only_room.db 存在，首次打开时自动迁移过来（同 schema，直接复用文件）。
import { DatabaseSync } from "node:sqlite";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, copyFileSync, existsSync, renameSync } from "node:fs";

const TABLES = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  client_id TEXT UNIQUE NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  birthday TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '只此一间',
  api_token TEXT UNIQUE NOT NULL,
  anniversary_date TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS room_members (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id);
CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  content_type TEXT NOT NULL,
  text TEXT,
  media_path TEXT,
  transcript TEXT,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_room ON memories(room_id);
CREATE INDEX IF NOT EXISTS idx_memories_recorded ON memories(recorded_at);
CREATE TABLE IF NOT EXISTS room_settings (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_room_settings_room ON room_settings(room_id);
`;

export function resolveDataDir(explicit) {
  // 优先级：插件 config.dataDir > 环境变量 > 默认 ~/.dsh/only-room。
  if (explicit) return explicit;
  if (process.env.ONLY_ROOM_DATA_DIR) return process.env.ONLY_ROOM_DATA_DIR;
  const targetDir = join(homedir(), ".dsh", "only-room");
  // 兼容旧 Python 后端：~/.only-room/only_room.db 存在则迁移到默认位置（同 schema，直接复用文件）。
  const legacy = join(homedir(), ".only-room", "only_room.db");
  if (existsSync(legacy) && !existsSync(join(targetDir, "only_room.db"))) {
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(legacy, join(targetDir, "only_room.db"));
  }
  return targetDir;
}

let _db = null;
let _dataDir = null;

export function openDb(explicitDir) {
  if (_db) return _db;
  _dataDir = resolveDataDir(explicitDir);
  mkdirSync(_dataDir, { recursive: true });
  const db = new DatabaseSync(join(_dataDir, "only_room.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(TABLES);
  _db = db;
  return db;
}

export function getDataDir() {
  if (!_dataDir) openDb();
  return _dataDir;
}

export function closeDb() {
  if (_db) { try { _db.close(); } catch {} _db = null; _dataDir = null; }
}

// ---- 小工具 ---------------------------------------------------------------
export function uid() {
  // 与 Python 端 uuid4 同形态（8-4-4-4-12），便于跨端兼容旧数据。
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function nowIso() {
  return new Date().toISOString();
}

// 把 Python 端存的 ISO（可能无 Z/带时区）规整为 SQLite 可比较的 UTC ISO。
export function toStoredDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value; // 存原样
  return d.toISOString();
}
