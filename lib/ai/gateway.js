// AI 网关：chat / embed / transcribe（移植自 backend/app/services/ai_gateway.py + providers/*）。
// 配置用 DSH 形态 {providers, select}。换模型/换 provider = 改配置，零代码改动。
// 未启用语义：select[cap].provider 为空/none → chat 抛错、embed 返回 []、transcribe 返回 ""。
// 面向小模型：Ollama / LM Studio / 任意 OpenAI 兼容 /v1 / whisper server。

const TIMEOUT_MS = { chat: 300_000, embed: 120_000, transcribe: 300_000, models: 10_000, health: 8_000 };

function isEnabled(sel) {
  return !!sel && !!sel.provider && sel.provider !== "none";
}

// 解析某能力的 (baseURL, apiKey, model, api)。
function resolve(cap, config) {
  const sel = (config.select && config.select[cap]) || {};
  if (!isEnabled(sel)) return null;
  const prov = (config.providers && config.providers[sel.provider]) || {};
  return {
    baseURL: (prov.baseURL || prov.base_url || "").replace(/\/+$/, "") || "http://localhost:11434",
    apiKey: prov.apiKey || prov.api_key || "",
    api: prov.api || "openai-completions",
    model: sel.model || "",
  };
}

async function jpost(url, { headers = {}, body, timeout } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, headers),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

async function jget(url, { headers = {}, timeout } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

// ---- chat -----------------------------------------------------------------
async function chat(messages, maxTokens, config) {
  const r = resolve("chat", config);
  if (!r) throw new Error("AI 未配置：chat.select.provider 为空，请在 AI 配置里填写");
  if (!r.model) throw new Error("chat 需要显式 model 名");
  const headers = {};
  if (r.apiKey) headers.authorization = `Bearer ${r.apiKey}`;
  if (r.api === "ollama") {
    const data = await jpost(`${r.baseURL}/api/chat`, {
      body: { model: r.model, messages, stream: false, options: { num_predict: maxTokens } },
      timeout: TIMEOUT_MS.chat,
    });
    return (data.message || {}).content || "";
  }
  // openai-completions（默认）
  const data = await jpost(`${r.baseURL}/chat/completions`, {
    headers, body: { model: r.model, messages, max_tokens: maxTokens }, timeout: TIMEOUT_MS.chat,
  });
  const choices = data.choices || [];
  return (choices[0] && choices[0].message && choices[0].message.content) || "";
}

// ---- embed ----------------------------------------------------------------
async function embed(texts, config) {
  const r = resolve("embed", config);
  if (!r) return []; // 未启用 → 空（搜索返回空，不报错）
  if (!r.model) throw new Error("embed 需要显式 model 名");
  const headers = {};
  if (r.apiKey) headers.authorization = `Bearer ${r.apiKey}`;
  if (r.api === "ollama") {
    const out = [];
    for (const text of texts) {
      const data = await jpost(`${r.baseURL}/api/embeddings`, {
        body: { model: r.model, prompt: text }, timeout: TIMEOUT_MS.embed,
      });
      out.push(data.embedding || []);
    }
    return out;
  }
  const data = await jpost(`${r.baseURL}/embeddings`, {
    headers, body: { model: r.model, input: texts }, timeout: TIMEOUT_MS.embed,
  });
  const items = (data.data || []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return items.map((it) => it.embedding || []);
}

// ---- transcribe -----------------------------------------------------------
async function transcribe(audioPath, language, config) {
  const r = resolve("transcribe", config);
  if (!r) return ""; // 未启用 → 空
  const headers = {};
  if (r.apiKey) headers.authorization = `Bearer ${r.apiKey}`;
  const model = r.model || "whisper-1";
  // multipart/form-data：file + model (+language)
  const form = new FormData();
  const { readFileSync } = await import("node:fs");
  const buf = readFileSync(audioPath);
  form.append("file", new Blob([buf]), `${audioPath.split(/[\\/]/).pop() || "audio"}`);
  form.append("model", model);
  if (language) form.append("language", language);
  const url = `${r.baseURL}/audio/transcriptions`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS.transcribe);
  try {
    const resp = await fetch(url, { method: "POST", headers, body: form, signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
    const data = await resp.json();
    return (data.text || "").trim();
  } finally {
    clearTimeout(t);
  }
}

// ---- health / test --------------------------------------------------------
async function testChat(config) {
  return chat([{ role: "user", content: "Say 'ok'" }], 10, config);
}

async function testEmbed(config) {
  const vectors = await embed(["hello"], config);
  if (!vectors.length) throw new Error("AI 未配置：embed.select.provider 为空");
  return vectors[0].length;
}

async function listModels(cap, config) {
  const r = resolve(cap, config);
  if (!r) return [];
  try {
    const headers = {};
    if (r.apiKey) headers.authorization = `Bearer ${r.apiKey}`;
    if (r.api === "ollama") {
      const data = await jget(`${r.baseURL}/api/tags`, { timeout: TIMEOUT_MS.models });
      return (data.models || []).map((m) => m.name || "");
    }
    const data = await jget(`${r.baseURL}/models`, { headers, timeout: TIMEOUT_MS.models });
    return (data.data || []).map((m) => m.id || "");
  } catch {
    return [];
  }
}

export const ai = { chat, embed, transcribe, testChat, testEmbed, listModels, resolve, isEnabled };
