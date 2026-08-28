// 当前用户资料（昵称/头像）+ 头像上传（移植自 backend/app/api/users_api.py）。
// 身份：X-Client-Id；认证：同时要求 X-Room-Token（只能改"自己所在房间"的成员资料）。
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { badRequest, unauthorized, notFound, unprocessable } from "../errors.js";

const AVATAR_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const MAX_AVATAR_BYTES = 4 * 1024 * 1024;

function resolveMe(db, { clientId, token } = {}) {
  clientId = (clientId || "").trim();
  token = (token || "").trim();
  if (!clientId) throw badRequest("Missing X-Client-Id");
  if (!token) throw unauthorized("Missing X-Room-Token");
  const user = db.prepare("SELECT * FROM users WHERE client_id=?").get(clientId);
  if (!user) throw notFound("User not found（请先完成连接/绑定）");
  const room = db.prepare("SELECT * FROM rooms WHERE api_token=?").get(token);
  if (!room) throw unauthorized("Invalid room token");
  return user;
}

export function getProfile(db, { clientId, token } = {}) {
  const user = resolveMe(db, { clientId, token });
  return { nickname: user.nickname || "", avatar_url: user.avatar_url || null };
}

export function updateProfile(db, { clientId, token, nickname } = {}) {
  const user = resolveMe(db, { clientId, token });
  db.prepare("UPDATE users SET nickname=? WHERE id=?").run(String(nickname || "").trim().slice(0, 50), user.id);
  const fresh = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
  return { nickname: fresh.nickname, avatar_url: fresh.avatar_url || null };
}

export function updateAvatar(db, dataDir, { clientId, token, filename, buffer } = {}) {
  const user = resolveMe(db, { clientId, token });
  if (!buffer) throw unprocessable("Empty avatar");
  if (buffer.length > MAX_AVATAR_BYTES) throw new (Error)("Avatar too large (max 4 MB)");
  const ext = (extname(filename || "") || "").toLowerCase();
  if (!AVATAR_EXT.has(ext)) throw unprocessable(`Unsupported avatar type ${ext} (allowed: jpg/png/webp/gif)`);
  const safeName = `${user.client_id.slice(0, 24)}${randomBytes(4).toString("hex")}${ext}`;
  const relPath = `avatars/${safeName}`;
  const dir = join(dataDir, "media", "avatars");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, safeName);
  // 路径穿越防护
  if (!dest.startsWith(dir)) throw unprocessable("Invalid file name");
  writeFileSync(dest, buffer);
  const url = `/only-room/media/${relPath}`;
  db.prepare("UPDATE users SET avatar_url=? WHERE id=?").run(url, user.id);
  return { avatar_url: url, nickname: user.nickname };
}
