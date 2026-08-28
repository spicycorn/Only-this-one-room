// 房间 + 绑定流程 + 房间级 Token 认证（移植自 backend/app/auth.py + api/rooms.py）。
// 身份模型：每个客户端持有稳定匿名 client_id；房主创建房间拿 api_token；成员填 token 后 bind 进房。
import { randomBytes } from "node:crypto";
import { uid, toStoredDate } from "../db.js";
import {
  badRequest, unauthorized, forbidden, notFound, conflict, unprocessable,
} from "../errors.js";

export function generateApiToken() {
  return randomBytes(32).toString("hex"); // 64 位 hex，与 Python secrets.token_hex(32) 同形态
}

export function roomOut(db, room, { withToken = false } = {}) {
  const memberCount = db.prepare("SELECT count(*) c FROM room_members WHERE room_id=?").get(room.id).c;
  const out = {
    id: room.id,
    name: room.name,
    anniversary_date: room.anniversary_date || null,
    created_at: room.created_at || null,
    member_count: memberCount,
  };
  if (withToken) out.api_token = room.api_token;
  return out;
}

export function membersOf(db, roomId) {
  const rows = db.prepare(
    `SELECT u.nickname, u.avatar_url, m.role, m.joined_at
       FROM room_members m JOIN users u ON u.id = m.user_id
      WHERE m.room_id = ? ORDER BY m.joined_at ASC`
  ).all(roomId);
  return rows.map((r) => ({
    nickname: r.nickname || "",
    avatar_url: r.avatar_url || null,
    role: r.role,
    joined_at: r.joined_at || null,
  }));
}

// 认证：校验 X-Room-Token → room（可选再解析 client_id → user）。
export function authRoom(db, { token, clientId } = {}) {
  if (!token) throw unauthorized("Missing X-Room-Token");
  const room = db.prepare("SELECT * FROM rooms WHERE api_token=?").get(token);
  if (!room) throw unauthorized("Invalid token");
  let user = null;
  if (clientId) user = db.prepare("SELECT * FROM users WHERE client_id=?").get(clientId) || null;
  return { room, user };
}

// 只按 token 查房间（token 唯一标识房间），找不到即 401。
export function requireRoom(db, token) {
  token = (token || "").trim();
  if (!token) throw unauthorized("Missing token");
  const room = db.prepare("SELECT * FROM rooms WHERE api_token=?").get(token);
  if (!room) throw unauthorized("Invalid token");
  return room;
}

// 创建房间（房主）。需 client_id；若已有房间则 409。
export function createRoom(db, { clientId, name, anniversaryDate } = {}) {
  clientId = (clientId || "").trim();
  if (!clientId) throw badRequest("Missing X-Client-Id");
  let user = db.prepare("SELECT * FROM users WHERE client_id=?").get(clientId);
  if (!user) {
    const id = uid();
    db.prepare("INSERT INTO users (id, client_id, nickname) VALUES (?,?,?)").run(id, clientId, "我");
    user = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  }
  const existing = db.prepare("SELECT id FROM room_members WHERE user_id=? LIMIT 1").get(user.id);
  if (existing) throw conflict("Already in a room");

  const roomId = uid();
  db.prepare("INSERT INTO rooms (id, name, api_token, anniversary_date) VALUES (?,?,?,?)")
    .run(roomId, (name || "只此一间").slice(0, 100), generateApiToken(), toStoredDate(anniversaryDate));
  db.prepare("INSERT INTO room_members (id, room_id, user_id, role) VALUES (?,?,?,?)")
    .run(uid(), roomId, user.id, "owner");
  const room = db.prepare("SELECT * FROM rooms WHERE id=?").get(roomId);
  return roomOut(db, room, { withToken: true }); // 一次性披露 token 供分享给另一半
}

// 当前 client_id 所在房间。
export function getMyRoom(db, { clientId, token } = {}) {
  clientId = (clientId || "").trim();
  if (!clientId) throw badRequest("Missing X-Client-Id");
  const user = db.prepare("SELECT * FROM users WHERE client_id=?").get(clientId);
  if (!user) throw notFound("User not found");
  const membership = db.prepare("SELECT * FROM room_members WHERE user_id=? LIMIT 1").get(user.id);
  if (!membership) throw notFound("Not in any room");
  const room = db.prepare("SELECT * FROM rooms WHERE id=?").get(membership.room_id);
  if (!room) throw notFound("Room not found");
  token = (token || "").trim();
  if (token && token !== room.api_token) throw forbidden("Token does not match your room");
  return roomOut(db, room, { withToken: true });
}

// 通过 api_token 绑定到已有房间（成员填 token 后自动调用）。
export function bindToRoom(db, { token, clientId, nickname } = {}) {
  const room = requireRoom(db, token);
  if (!clientId) throw badRequest("Missing clientId");
  clientId = (clientId || "").trim();
  let user = db.prepare("SELECT * FROM users WHERE client_id=?").get(clientId);
  if (!user) {
    const id = uid();
    db.prepare("INSERT INTO users (id, client_id, nickname) VALUES (?,?,?)").run(id, clientId, (nickname || "").trim());
    user = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  }
  const existing = db.prepare("SELECT id FROM room_members WHERE room_id=? AND user_id=?").get(room.id, user.id);
  if (existing) throw conflict("Already bound to this room");
  db.prepare("INSERT INTO room_members (id, room_id, user_id, role) VALUES (?,?,?,?)").run(uid(), room.id, user.id, "member");
  return roomOut(db, room);
}

// 房间成员列表（只按 token 查）。
export function listMembers(db, { token } = {}) {
  const room = requireRoom(db, token);
  return { room_id: room.id, members: membersOf(db, room.id) };
}

// 房间信息（需有效 token）。
export function getRoom(db, { token } = {}) {
  const room = requireRoom(db, token);
  return roomOut(db, room);
}

// 更新房间信息（名称、纪念日）。
export function updateRoom(db, { token, name, anniversaryDate } = {}) {
  const room = requireRoom(db, token);
  if (name) db.prepare("UPDATE rooms SET name=? WHERE id=?").run(String(name).slice(0, 100), room.id);
  if (anniversaryDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(anniversaryDate))) {
      throw unprocessable("Invalid anniversary_date (expected YYYY-MM-DD)");
    }
    db.prepare("UPDATE rooms SET anniversary_date=? WHERE id=?").run(String(anniversaryDate), room.id);
  }
  return { detail: "updated" };
}
