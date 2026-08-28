// 向量存储：SQLite 存 embedding + JS 算 cosine 相似度（替代 Python 专属的 ChromaDB）。
// 两人记忆量级（数百~数千条），内存算 cosine 绰绰有余，零额外依赖。
import { uid } from "../db.js";

const ENSURE = `
CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  embedding TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_vectors_room ON memory_vectors(room_id);
`;

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function initVectorStore(db) {
  db.exec(ENSURE);
  return {
    upsert(memoryId, roomId, embedding, text) {
      const json = JSON.stringify(embedding);
      const exists = db.prepare("SELECT 1 FROM memory_vectors WHERE memory_id=?").get(memoryId);
      if (exists) db.prepare("UPDATE memory_vectors SET room_id=?, embedding=?, text=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE memory_id=?").run(roomId, json, String(text || "").slice(0, 4000), memoryId);
      else db.prepare("INSERT INTO memory_vectors (memory_id, room_id, embedding, text) VALUES (?,?,?,?)").run(memoryId, roomId, json, String(text || "").slice(0, 4000));
    },
    query(roomId, embedding, limit = 10) {
      const rows = db.prepare("SELECT memory_id, embedding, text FROM memory_vectors WHERE room_id=?").all(roomId);
      const scored = rows.map((r) => {
        let emb = [];
        try { emb = JSON.parse(r.embedding); } catch { emb = []; }
        return { memory_id: r.memory_id, text: r.text, distance: 1 - cosine(emb, embedding) };
      });
      scored.sort((a, b) => a.distance - b.distance);
      return scored.slice(0, limit);
    },
    delete(memoryId) {
      db.prepare("DELETE FROM memory_vectors WHERE memory_id=?").run(memoryId);
    },
    count(roomId) {
      return db.prepare("SELECT count(*) c FROM memory_vectors WHERE room_id=?").get(roomId).c;
    },
  };
}
