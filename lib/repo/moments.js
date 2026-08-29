// AI 主动时刻（移植自 backend/app/api/moments_api.py）：纪念日/生日/记录周年/沉默提醒。
// 原则：不推送、不打扰，只有打开时才在。本端只负责"算出来 + 去重标记"，展示由客户端完成。
// 频率控制：记录周年对同一条记录、同一里程碑只触发一次（room_settings 记已展示的人，按人去重）。
import { uid } from "../db.js";
import { unauthorized } from "../errors.js";

const MILESTONES = new Set([1, 2, 5]);
const CN_YEARS = { 1: "一周年", 2: "两周年", 5: "五周年" };

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function sameMd(a, b) {
  return a && b && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

function mediaLabel(m) {
  if (m.content_type === "image") return "[一张图片]";
  if (m.content_type === "audio") return "[一段语音]";
  return "";
}

function seenUsers(value) {
  if (!value) return new Set();
  try {
    const data = JSON.parse(value);
    const users = Array.isArray(data) ? data : (data && Array.isArray(data.users) ? data.users : []);
    return new Set(users);
  } catch { return new Set(); }
}

function markSeen(db, roomId, key, userIds) {
  const row = db.prepare("SELECT * FROM room_settings WHERE room_id=? AND key=?").get(roomId, key);
  const seen = seenUsers(row?.value);
  for (const u of userIds) if (u) seen.add(u);
  const value = JSON.stringify({ users: [...seen].sort() });
  if (row) db.prepare("UPDATE room_settings SET value=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(value, row.id);
  else db.prepare("INSERT INTO room_settings (id, room_id, key, value) VALUES (?,?,?,?)").run(uid(), roomId, key, value);
}

export function getMoments(db, { token, clientId, markRecordAnniversaries = true } = {}) {
  const room = db.prepare("SELECT * FROM rooms WHERE api_token=?").get((token || "").trim());
  if (!room) throw unauthorized("Invalid token");
  const me = clientId ? db.prepare("SELECT * FROM users WHERE client_id=?").get((clientId || "").trim()) || null : null;
  const today = new Date();

  const out = { anniversary: null, birthday: null, record_anniversaries: [], silence_reminder: null };

  // --- 1. 在一起纪念日（今天/明天）---
  const anniv = parseDate(room.anniversary_date);
  if (anniv) {
    const annivThisYear = new Date(Date.UTC(today.getUTCFullYear(), anniv.getUTCMonth(), anniv.getUTCDate()));
    const diffDays = Math.round((annivThisYear - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86400000);
    let when = null, years = 0;
    if (diffDays === 0) { when = "today"; years = Math.max(1, today.getUTCFullYear() - anniv.getUTCFullYear()) || 1; }
    else if (diffDays === 1) when = "tomorrow";
    let text = "";
    const extra = {};
    if (when) {
      // "去年今天"引用：取去年纪念日附近一条记录
      const target = new Date(Date.UTC(today.getUTCFullYear() - 1, anniv.getUTCMonth(), anniv.getUTCDate()));
      const from = new Date(target.getTime() - 86400000).toISOString().slice(0, 10);
      const to = target.toISOString().slice(0, 10);
      const q = db.prepare(
        `SELECT * FROM memories WHERE room_id=? AND substr(recorded_at,1,10) >= ? AND substr(recorded_at,1,10) <= ?
           ORDER BY recorded_at DESC LIMIT 1`
      ).get(room.id, from, to);
      if (q) {
        const qt = ((q.text || "").trim() || (q.transcript || "").trim()).slice(0, 80);
        extra.last_year_memory_id = q.id;
        text += "去年今天你们存了：" + (qt ? `“${qt}”` : mediaLabel(q));
      }
    }
    if (when === "today") text = `💕 今天是你们的纪念日，第 ${years} 年。` + (text ? text : "");
    else if (when === "tomorrow") text = `🌸 明天是你们在一起的纪念日（${anniv.getUTCMonth() + 1}月${anniv.getUTCDate()}日）。` + (text ? text : "");
    out.anniversary = when ? { when, text: text || null, ...extra } : null;
  }

  // --- 2. 成员生日（今天/明天）---
  const members = db.prepare(
    `SELECT u.nickname, u.birthday FROM users u JOIN room_members m ON m.user_id=u.id
      WHERE m.room_id=? AND u.birthday IS NOT NULL ORDER BY m.joined_at`
  ).all(room.id);
  const tomorrow = new Date(today.getTime() + 86400000);
  for (const u of members) {
    const b = parseDate(u.birthday);
    if (!b) continue;
    const bdayThisYear = new Date(Date.UTC(today.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()));
    const bDiff = Math.round((bdayThisYear - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86400000);
    if (bDiff === 0 || sameMd(b, tomorrow)) {
      const whenB = bDiff === 0 ? "today" : "tomorrow";
      out.birthday = {
        name: u.nickname || "", when: whenB,
        text: `🎂 ${whenB === "today" ? "今天" : "明天"}是${u.nickname}的生日。`,
      };
      break;
    }
  }

  // --- 3. 记录周年（1/2/5 年，按人去重）---
  const mems = db.prepare("SELECT * FROM memories WHERE room_id=? ORDER BY recorded_at DESC").all(room.id);
  for (const m of mems) {
    if (out.record_anniversaries.length >= 3) break;
    const recorded = parseDate(m.recorded_at);
    if (!recorded || !sameMd(recorded, today)) continue;
    const yearsM = today.getUTCFullYear() - recorded.getUTCFullYear();
    if (!MILESTONES.has(yearsM)) continue;
    const key = `moment_record:${m.id}:${yearsM}y`;
    const row = db.prepare("SELECT * FROM room_settings WHERE room_id=? AND key=?").get(room.id, key);
    const seen = seenUsers(row?.value);
    if (me) {
      if (seen.has(me.id)) continue;
      if (markRecordAnniversaries) markSeen(db, room.id, key, [me.id]);
    }
    const qt = ((m.text || "").trim() || (m.transcript || "").trim()).slice(0, 80);
    const shown = qt ? `“${qt}”` : mediaLabel(m);
    out.record_anniversaries.push({
      memory_id: m.id, years: yearsM,
      text: `${CN_YEARS[yearsM] || yearsM + "年"}了：${shown}`,
    });
  }

  // --- 4. 沉默提醒（连续 7 天无新记录）---
  const lastRow = db.prepare("SELECT max(recorded_at) last_at FROM memories WHERE room_id=?").get(room.id);
  if (lastRow?.last_at) {
    const last = parseDate(lastRow.last_at);
    if (last) {
      const daysSilent = Math.round((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) -
        Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate())) / 86400000);
      if (daysSilent >= 7) out.silence_reminder = "已经一周没记录了哦。";
    }
  }

  return out;
}
