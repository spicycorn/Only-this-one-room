// 数据导出（移植自 backend/app/api/export_api.py）：json 结构化快照 / zip 完整备份。
// zip 用内置最小 store 写入器（零依赖，不压缩，CRC32 自算）。
import { readdirSync, readFileSync, statSync, existsSync, openSync, closeSync, fstatSync } from "node:fs";
import { join, relative } from "node:path";
import { unauthorized, unprocessable } from "../errors.js";

function verifyRoom(db, token) {
  const room = db.prepare("SELECT * FROM rooms WHERE api_token=?").get((token || "").trim());
  if (!room) throw unauthorized("Invalid token");
  return room;
}

function timestampTag() {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

// ---- 最小 ZIP（store）写入器 ---------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// files: [{name, data:Buffer}] → zip Buffer
function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = crc32(data);
    const { time, date } = dosDateTime();
    // local header
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);   // version needed
    lh.writeUInt16LE(0, 6);    // flags
    lh.writeUInt16LE(0, 8);    // compression: store
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, data);
    // central dir entry
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);   // version made by
    cd.writeUInt16LE(20, 6);   // version needed
    cd.writeUInt16LE(0, 8);    // flags
    cd.writeUInt16LE(0, 10);   // compression
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    // 30-45: extra(0)/comment(0)/disk(0)/int attrs(0)/ext attrs(0)
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([cd, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

function walk(dir, base, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else {
      if (entry.endsWith(".tmp")) continue;
      out.push({ name: relative(base, full).split("\\").join("/"), data: readFileSync(full) });
    }
  }
}

export function exportJson(db, { token } = {}) {
  const room = verifyRoom(db, token);
  const rooms = db.prepare("SELECT * FROM rooms ORDER BY created_at").all();
  const roomIds = rooms.map((r) => r.id);
  const members = roomIds.length
    ? db.prepare(`SELECT m.room_id, u.nickname FROM room_members m JOIN users u ON u.id=m.user_id WHERE m.room_id IN (${roomIds.map(() => "?").join(",")})`).all(...roomIds)
    : [];
  const memories = db.prepare("SELECT * FROM memories ORDER BY recorded_at").all();
  const settingsRows = roomIds.length
    ? db.prepare(`SELECT room_id, key, value FROM room_settings WHERE room_id IN (${roomIds.map(() => "?").join(",")})`).all(...roomIds)
    : [];
  const settingsMap = {};
  for (const s of settingsRows) (settingsMap[s.room_id] ||= {})[s.key] = s.value;

  const payload = {
    app: "only-room", version: 2, exported_at: new Date().toISOString(),
    rooms: rooms.map((r) => ({
      id: r.id, name: r.name,
      anniversary_date: r.anniversary_date || null,
      created_at: r.created_at || new Date().toISOString(),
    })),
    members: members.map((m) => ({ room_id: m.room_id, nickname: m.nickname })),
    memories: memories.map((m) => ({
      id: m.id, room_id: m.room_id, user_id: m.user_id || null, content_type: m.content_type,
      text: m.text || null, media_path: m.media_path ? `/only-room/media/${m.media_path}` : null,
      transcript: m.transcript || null, recorded_at: m.recorded_at || new Date().toISOString(),
    })),
    room_settings: settingsMap,
  };
  return {
    filename: `only_room_backup_${timestampTag()}.json`,
    contentType: "application/json; charset=utf-8",
    body: Buffer.from(JSON.stringify(payload, null, 2), "utf8"),
  };
}

export function exportZip(db, dataDir, { token } = {}) {
  const room = verifyRoom(db, token);
  const dbPath = join(dataDir, "only_room.db");
  if (!existsSync(dbPath)) throw unprocessable("No database found");
  const files = [{ name: "data/only_room.db", data: readFileSync(dbPath) }];
  const mediaDir = join(dataDir, "media");
  if (existsSync(mediaDir)) walk(mediaDir, dataDir, files);
  return {
    filename: `only_room_backup_${timestampTag()}.zip`,
    contentType: "application/zip",
    body: zipStore(files),
  };
}
