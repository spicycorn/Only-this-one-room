// 设置：房间主题 + AI 开关 + AI 模型配置（移植自 backend/app/api/settings_api.py）。
// AI 配置改用 DSH 的 llm-pi-ai 形态：providers.<name>.{baseURL,apiKey,api,models[]} + 各能力 select.{provider,model}，
// 面向小模型（Ollama / LM Studio / 任意 OpenAI 兼容 /v1）。
import { uid } from "../db.js";
import { unauthorized } from "../errors.js";

function verifyRoom(db, { roomId, token } = {}) {
  token = (token || "").trim();
  if (!token) throw unauthorized("Missing token");
  const room = db.prepare("SELECT * FROM rooms WHERE api_token=?").get(token);
  if (!room) throw unauthorized("Invalid token");
  if (roomId && room.id !== roomId) throw unauthorized("Room mismatch");
  return room;
}

function upsertSetting(db, roomId, key, value) {
  const existing = db.prepare("SELECT id FROM room_settings WHERE room_id=? AND key=?").get(roomId, key);
  if (existing) db.prepare("UPDATE room_settings SET value=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE room_id=? AND key=?").run(value, roomId, key);
  else db.prepare("INSERT INTO room_settings (id, room_id, key, value) VALUES (?,?,?,?)").run(uid(), roomId, key, value);
}

function allSettings(db, roomId) {
  const rows = db.prepare("SELECT key, value FROM room_settings WHERE room_id=?").all(roomId);
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

// AI 配置的默认值（DSH 形态）。
export function defaultAiConfig() {
  return {
    providers: {
      ollama: { baseURL: "http://localhost:11434", apiKey: "", api: "openai-completions", models: [] },
    },
    select: {
      chat: { provider: "ollama", model: "" },
      embed: { provider: "ollama", model: "" },
      transcribe: { provider: "ollama", model: "" },
    },
  };
}

export function getRoomSettings(db, { roomId, token } = {}) {
  const room = verifyRoom(db, { roomId, token });
  const rows = allSettings(db, room.id);
  let theme = {};
  if (rows.theme) { try { theme = JSON.parse(rows.theme); } catch { theme = {}; } }
  const aiEnabled = (rows.ai_enabled || "true").toLowerCase() !== "false";
  let aiConfig = defaultAiConfig();
  if (rows["ai-config"]) {
    try {
      const parsed = JSON.parse(rows["ai-config"]);
      // 兼容旧扁平格式 {chat:{provider,base_url,...}} → 新 DSH 形态
      aiConfig = normalizeAiConfig(parsed);
    } catch { aiConfig = defaultAiConfig(); }
  }
  return { theme, ai_enabled: aiEnabled, ai_config: aiConfig };
}

// 把任意形态的 AI 配置规整为 DSH 形态 {providers, select}。
export function normalizeAiConfig(raw) {
  const out = defaultAiConfig();
  if (!raw || typeof raw !== "object") return out;
  // 新格式
  if (raw.providers) out.providers = { ...out.providers, ...raw.providers };
  if (raw.select) {
    for (const k of ["chat", "embed", "transcribe"]) {
      if (raw.select[k]) out.select[k] = { ...out.select[k], ...raw.select[k] };
    }
  }
  // 旧扁平格式 {chat:{provider,base_url,api_key,model}, ...}
  for (const k of ["chat", "embed", "transcribe"]) {
    const part = raw[k];
    if (part && typeof part === "object" && part.provider) {
      const providerName = part.provider;
      const baseURL = part.base_url || part.baseURL;
      const apiKey = part.api_key || part.apiKey || "";
      const model = part.model || "";
      if (baseURL && !out.providers[providerName]) {
        out.providers[providerName] = { baseURL, apiKey: "", api: "openai-completions", models: model ? [{ id: model }] : [] };
      }
      out.select[k] = { provider: providerName, model };
    }
  }
  return out;
}

export function updateAiConfig(db, { roomId, token, config } = {}) {
  const room = verifyRoom(db, { roomId, token });
  const normalized = normalizeAiConfig(config || {});
  upsertSetting(db, room.id, "ai-config", JSON.stringify(normalized));
  return { detail: "AI config updated", ai_config: normalized };
}

export function getTheme(db, { roomId, token } = {}) {
  const s = getRoomSettings(db, { roomId, token });
  return s.theme;
}

export function updateTheme(db, { roomId, token, theme } = {}) {
  const room = verifyRoom(db, { roomId, token });
  const clean = {};
  for (const [k, v] of Object.entries(theme || {})) if (v !== null && v !== undefined) clean[k] = v;
  upsertSetting(db, room.id, "theme", JSON.stringify(clean));
  return { detail: "theme updated", theme: clean };
}

export function toggleAi(db, { roomId, token, enabled = true } = {}) {
  const room = verifyRoom(db, { roomId, token });
  upsertSetting(db, room.id, "ai_enabled", String(!!enabled).toLowerCase());
  return { detail: `AI ${enabled ? "enabled" : "disabled"}`, ai_enabled: !!enabled };
}
