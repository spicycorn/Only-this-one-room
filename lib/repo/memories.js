// 记录（记忆）CRUD + 媒体存取（移植自 backend/app/api/memories.py）。
// 媒体文件落在 <dataDir>/media/<room_id>/<uuid>.<ext>；AI 转写/嵌入通过注入的 gateway 异步完成（非致命）。
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { uid } from "../db.js";
import { unauthorized, notFound, unprocessable } from "../errors.js";

const ALLOWED_EXT = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg",
  ".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".opus",
  ".mp4", ".mov", ".webm",
]);

export function mediaDir(dataDir, roomId) {
  const d = join(dataDir, "media", roomId);
  mkdirSync(d, { recursive: true });
  return d;
}

export function resolveUser(db, clientId) {
  clientId = (clientId || "").trim();
  if (!clientId) return null;
  return db.prepare("SELECT * FROM users WHERE client_id=?").get(clientId) || null;
}

function toOut(m, authorName) {
  return {
    id: m.id, room_id: m.room_id, user_id: m.user_id || null,
    author_name: authorName || null, content_type: m.content_type,
    text: m.text || null, media_path: m.media_path || null, transcript: m.transcript || null,
    recorded_at: m.recorded_at, created_at: m.created_at,
  };
}

function authorNames(db, userIds) {
  if (!userIds.length) return {};
  const marks = userIds.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id, nickname FROM users WHERE id IN (${marks})`).all(...userIds);
  const map = {};
  for (const r of rows) map[r.id] = r.nickname;
  return map;
}

export function createMemory(db, dataDir, { token, clientId, contentType, text, mediaPath, recordedAt, transcript }, ai) {
  const room = db.prepare("SELECT * FROM rooms WHERE api_token=?").get((token || "").trim());
  if (!room) throw unauthorized("Invalid token");
  const user = resolveUser(db, clientId);
  const id = uid();
  db.prepare(
    `INSERT INTO memories (id, room_id, user_id, content_type, text, media_path, transcript, recorded_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, room.id, user?.id || null, contentType, text || null, mediaPath || null, transcript || null, recordedAt || new Date().toISOString());
  const memory = db.prepare("SELECT * FROM memories WHERE id=?").get(id);

  // 背景 AI（非致命）：音频转写 / 文本嵌入。ai 为注入的网关，缺失则跳过。
  if (ai) {
    try {
      if (contentType === "audio" && memory.media_path && ai.transcribeConfigured) {
        setImmediate(() => {
          (async () => {
            try {
              const fp = join(dataDir, "media", memory.media_path);
              const text2 = (await ai.transcribe(fp)) || "";
              const t = text2.trim();
              const parts = [];
              if (t) parts.push(t);
              if (memory.text && memory.text.trim()) parts.push(memory.text.trim());
              if (t) db.prepare("UPDATE memories SET transcript=? WHERE id=?").run(t, id);
              const combined = parts.join(" ").trim();
              if (combined && ai.embedConfigured && ai.embed) {
                const vectors = await ai.embed([combined]);
                if (vectors?.[0]) await ai.upsertVector?.(id, room.id, vectors[0], combined);
              }
            } catch {}
          })();
        });
      } else if (text && text.trim() && ai.embedConfigured && ai.embed) {
        const searchable = text.trim();
        setImmediate(() => {
          (async () => {
            try {
              const vectors = await ai.embed([searchable]);
              if (vectors?.[0]) await ai.upsertVector?.(id, room.id, vectors[0], searchable);
            } catch {}
          })();
        });
      }
    } catch {}
  }
  return toOut(memory, user?.nickname);
}

export function listMemories(db, { token, page = 1, size = 20, contentType } = {}) {
  const room = db.prepare("SELECT * FROM rooms WHERE api_token=?").get((token || "").trim());
  if (!room) throw unauthorized("Invalid token");
  page = Math.max(1, page | 0);
  size = Math.min(100, Math.max(1, size | 0));
  const where = ["room_id = ?"];
  const params = [room.id];
  if (contentType) { where.push("content_type = ?"); params.push(contentType); }
  const whereSql = where.join(" AND ");
  const total = db.prepare(`SELECT count(*) c FROM memories WHERE ${whereSql}`).get(...params).c;
  const rows = db.prepare(
    `SELECT * FROM memories WHERE ${whereSql} ORDER BY recorded_at DESC LIMIT ? OFFSET ?`
  ).all(...params, size, (page - 1) * size);
  const names = authorNames(db, rows.map((r) => r.user_id).filter(Boolean));
  return {
    items: rows.map((r) => toOut(r, names[r.user_id])),
    total, page, size,
  };
}

export function updateMemory(db, { token, memoryId, contentType, text, transcript, recordedAt, mediaPath } = {}) {
  const room = db.prepare("SELECT * FROM rooms WHERE api_token=?").get((token || "").trim());
  if (!room) throw unauthorized("Invalid token");
  const m = db.prepare("SELECT * FROM memories WHERE id=? AND room_id=?").get(memoryId, room.id);
  if (!m) throw notFound("Memory not found");
  const next = {
    content_type: contentType || m.content_type,
    text: text === undefined ? m.text : (text || null),
    transcript: transcript === undefined ? m.transcript : (transcript || null),
    media_path: mediaPath === undefined ? m.media_path : (mediaPath || null),
    recorded_at: recordedAt || m.recorded_at,
  };
  db.prepare("UPDATE memories SET content_type=?, text=?, transcript=?, media_path=?, recorded_at=? WHERE id=?")
    .run(next.content_type, next.text, next.transcript, next.media_path, next.recorded_at, memoryId);
  const updated = db.prepare("SELECT * FROM memories WHERE id=?").get(memoryId);
  const names = authorNames(db, updated.user_id ? [updated.user_id] : []);
  return toOut(updated, names[updated.user_id]);
}

export function getMemory(db, { token, memoryId } = {}) {
  const room = db.prepare("SELECT * FROM rooms WHERE api_token=?").get((token || "").trim());
  if (!room) throw unauthorized("Invalid token");
  const m = db.prepare("SELECT * FROM memories WHERE id=? AND room_id=?").get(memoryId, room.id);
  if (!m) throw notFound("Memory not found");
  const names = authorNames(db, m.user_id ? [m.user_id] : []);
  return toOut(m, names[m.user_id]);
}

export function deleteMemory(db, dataDir, { token, memoryId }, ai) {
  const room = db.prepare("SELECT * FROM rooms WHERE api_token=?").get((token || "").trim());
  if (!room) throw unauthorized("Invalid token");
  const m = db.prepare("SELECT * FROM memories WHERE id=? AND room_id=?").get(memoryId, room.id);
  if (!m) throw notFound("Memory not found");
  if (m.media_path) {
    const fp = join(dataDir, "media", m.media_path);
    if (existsSync(fp)) { try { unlinkSync(fp); } catch {} }
  }
  if (ai?.deleteVector) { try { ai.deleteVector(memoryId); } catch {} }
  db.prepare("DELETE FROM memories WHERE id=?").run(memoryId);
  return { detail: "deleted" };
}

// 上传媒体（base64 或 Buffer），返回 media_path（相对 data/media/）。
export function uploadMedia(db, dataDir, { token, filename, contentType, buffer } = {}) {
  const room = db.prepare("SELECT * FROM rooms WHERE api_token=?").get((token || "").trim());
  if (!room) throw unauthorized("Invalid token");
  if (!buffer) throw unprocessable("Empty upload");
  const ext = (extname(filename || "") || "").toLowerCase() || ".bin";
  if (!ALLOWED_EXT.has(ext)) throw unprocessable(`Unsupported file type ${ext}`);
  const safeName = randomBytes(16).toString("hex") + ext;
  const relPath = `${room.id}/${safeName}`;
  mkdirSync(join(dataDir, "media", room.id), { recursive: true }); // 确保 <room_id> 目录存在
  writeFileSync(join(dataDir, "media", relPath), buffer);
  return { media_path: relPath, url: `/only-room/media/${relPath}` };
}

// 读取媒体（host 路由 /only-room/media/<relPath> 用）。
export function readMedia(dataDir, relPath) {
  const safe = String(relPath || "").replace(/^\/+/, "");
  if (safe.includes("..") || safe.includes("\0")) return null;
  const fp = join(dataDir, "media", safe);
  if (!existsSync(fp)) return null;
  return readFileSync(fp);
}

// 删除媒体文件（按相对路径），返回是否删除。
export function deleteMediaFile(dataDir, relPath) {
  const safe = String(relPath || "").replace(/^\/+/, "");
  if (safe.includes("..") || safe.includes("\0")) throw new AppError(400, "bad media path");
  const fp = join(dataDir, "media", safe);
  if (!existsSync(fp)) return false;
  unlinkSync(fp);
  return true;
}

// 全文搜索（LIKE；语义检索在 Stage 5 的 AI 网关里叠加）。
export function searchMemories(db, { token, q, page = 1, size = 20 } = {}) {
  const room = db.prepare("SELECT * FROM rooms WHERE api_token=?").get((token || "").trim());
  if (!room) throw unauthorized("Invalid token");
  q = (q || "").trim();
  if (!q) return listMemories(db, { token, page, size });
  page = Math.max(1, page | 0);
  size = Math.min(100, Math.max(1, size | 0));
  const like = `%${q}%`;
  const total = db.prepare(
    `SELECT count(*) c FROM memories WHERE room_id=? AND (text LIKE ? OR transcript LIKE ?)`
  ).get(room.id, like, like).c;
  const rows = db.prepare(
    `SELECT * FROM memories WHERE room_id=? AND (text LIKE ? OR transcript LIKE ?)
       ORDER BY recorded_at DESC LIMIT ? OFFSET ?`
  ).all(room.id, like, like, size, (page - 1) * size);
  const names = authorNames(db, rows.map((r) => r.user_id).filter(Boolean));
  return { items: rows.map((r) => toOut(r, names[r.user_id])), total, page, size };
}
