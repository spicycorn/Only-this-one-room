// 语义搜索 + 关联推荐（移植自 backend/app/api/search.py）。
// 依赖注入的 ai（网关）+ vs（向量库）。AI 未配置/不可用时优雅降级为空结果。
import { unauthorized, notFound } from "../errors.js";

function verifyRoom(db, token) {
  const room = db.prepare("SELECT * FROM rooms WHERE api_token=?").get((token || "").trim());
  if (!room) throw unauthorized("Invalid token");
  return room;
}

function authorNames(db, userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return {};
  const marks = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id, nickname FROM users WHERE id IN (${marks})`).all(...ids);
  const map = {};
  for (const r of rows) map[r.id] = r.nickname;
  return map;
}

function toResult(m, authorName, score) {
  return {
    id: m.id, room_id: m.room_id, user_id: m.user_id || null, author_name: authorName || null,
    content_type: m.content_type, text: m.text || null, media_path: m.media_path || null,
    transcript: m.transcript || null, recorded_at: m.recorded_at, created_at: m.created_at,
    score,
  };
}

// 语义搜索：query → embed → 向量库 top-K → 回 DB 取全字段。需要 config（DSH 形态）以调用 ai.embed。
export async function semanticSearch(db, ai, vs, { token, query, limit = 10, config } = {}) {
  const room = verifyRoom(db, token);
  let queryVectors;
  try {
    queryVectors = await ai.embed([query], config);
  } catch (e) {
    throw new (Object.getPrototypeOf(e) === Error ? Error : e)(`AI 服务不可用: ${e.message}`);
  }
  if (!queryVectors || !queryVectors.length) return [];
  const results = vs.query(room.id, queryVectors[0], limit);
  if (!results.length) return [];
  const ids = results.map((r) => r.memory_id);
  const marks = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM memories WHERE id IN (${marks})`).all(...ids);
  const memById = {};
  for (const m of rows) memById[m.id] = m;
  const names = authorNames(db, rows.map((m) => m.user_id));
  const out = [];
  for (const r of results) {
    const m = memById[r.memory_id];
    if (!m) continue;
    out.push(toResult(m, names[m.user_id], Math.round((1 - r.distance) * 10000) / 10000));
  }
  return out;
}

export async function getRelated(db, ai, vs, { token, memoryId, config } = {}) {
  const room = verifyRoom(db, token);
  const memory = db.prepare("SELECT * FROM memories WHERE id=? AND room_id=?").get(memoryId, room.id);
  if (!memory) throw notFound("Memory not found");
  const text = (memory.text || memory.transcript || "").trim();
  if (!text) return [];
  let vectors = [];
  try { vectors = await ai.embed([text], config); } catch { return []; }
  if (!vectors || !vectors.length) return [];
  let results = vs.query(room.id, vectors[0], 4).filter((r) => r.memory_id !== memoryId).slice(0, 3);
  if (!results.length) return [];
  const ids = results.map((r) => r.memory_id);
  const marks = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM memories WHERE id IN (${marks})`).all(...ids);
  const memById = {};
  for (const m of rows) memById[m.id] = m;
  const names = authorNames(db, rows.map((m) => m.user_id));
  return results.map((r) => {
    const m = memById[r.memory_id];
    if (!m) return null;
    return toResult(m, names[m.user_id], Math.round((1 - r.distance) * 10000) / 10000);
  }).filter(Boolean);
}
