/**
 * 只此一间 — DSH Cordis plugin（host 半）· 插件即应用。
 *
 * 本插件**自包含整个应用**：数据层(node:sqlite) + 业务逻辑 + AI 网关 + 媒体存储都在 host 半。
 * 没有独立后端进程、没有端口。浏览器半（client）通过受信任栅栏保护的 `/only-room/api`
 * RPC 调用全部数据操作；媒体文件经 `/only-room/media` 路由读取。
 *
 * 数据落在稳定目录（默认 ~/.dsh/only-room/，可被 config.dataDir / ONLY_ROOM_DATA_DIR 覆盖）。
 */

import z from "schemastery";
import { openDb, closeDb, getDataDir } from "./lib/db.js";
import { initVectorStore } from "./lib/ai/vector.js";
import { ai } from "./lib/ai/gateway.js";
import * as rooms from "./lib/repo/rooms.js";
import * as memories from "./lib/repo/memories.js";
import * as settings from "./lib/repo/settings.js";
import * as users from "./lib/repo/users.js";
import * as moments from "./lib/repo/moments.js";
import * as searchRepo from "./lib/repo/search.js";
import * as exportRepo from "./lib/repo/export.js";
import { AppError, badGateway } from "./lib/errors.js";

const name = "only-room-admin";

// 插件配置：数据目录（空串 = 默认 ~/.dsh/only-room/）。
const Config = z.object({
	dataDir: z.string().default(""),
});

function resolveConfig(config) {
	return { dataDir: (config?.dataDir ?? "").trim() };
}

// ---- 信任栅栏（浏览器跨域防护，同 DSH webserver 自身路由的形状）------------------
function isTrustedApiRequest(request, trustedHosts) {
	const headers = request.headers ?? {};
	const hostHeader = String(headers.host ?? "");
	if (!hostHeader) return false;
	let url;
	try { url = new URL(`http://${hostHeader}`); } catch { return false; }
	const hostname = (url.hostname || "").toLowerCase();
	const loopback = hostname === "localhost" || /^127\./.test(hostname) || hostname === "::1";
	if (!loopback && !trustedHosts.some((t) => String(t).replace(/\/+$/, "") === `${hostname}:${url.port}`)) return false;
	const secFetchSite = headers["sec-fetch-site"];
	if (typeof secFetchSite === "string" && /cross-site/i.test(secFetchSite)) return false;
	const originHeader = headers.origin ?? headers.referer;
	if (!originHeader) return true;
	try { return new URL(originHeader).host === url.host; } catch { return false; }
}

function writeJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
function writeBuffer(res, status, body, headers = {}) {
	res.writeHead(status, headers);
	res.end(body);
}

async function readJsonBody(req, maxBytes = 16 * 1024 * 1024) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += Buffer.byteLength(chunk);
		if (total > maxBytes) throw new Error("request body too large");
		chunks.push(Buffer.from(typeof chunk === "string" ? chunk : String(chunk)));
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	return text === "" ? {} : JSON.parse(text);
}

// 从房间设置里取 AI 配置（DSH 形态），供网关调用。
function aiConfigFor(db, token) {
	try {
		const room = db.prepare("SELECT * FROM rooms WHERE api_token=?").get((token || "").trim());
		if (!room) return settings.defaultAiConfig();
		const s = settings.getRoomSettings(db, { roomId: room.id, token });
		return s.ai_config;
	} catch {
		return settings.defaultAiConfig();
	}
}

const MIME = {
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
	".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml",
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
	".aac": "audio/aac", ".flac": "audio/flac", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
};
function mimeOf(path) {
	const dot = path.lastIndexOf(".");
	if (dot < 0) return "application/octet-stream";
	return MIME[path.slice(dot).toLowerCase()] || "application/octet-stream";
}

function apply(ctx, config) {
	const resolved = resolveConfig(config);
	const db = openDb(resolved.dataDir);
	const vs = initVectorStore(db);
	const dataDir = getDataDir();
	ctx.logger?.info?.(`[only-room-admin] app ready · dataDir=${dataDir}`);

	// 把 AppError / 普通 Error 映射到 HTTP 状态。
	const statusOf = (e) => (e instanceof AppError ? e.status : 500);

	// ---- RPC 分发 -----------------------------------------------------------
	async function dispatch(db, action, p) {
		switch (action) {
			case "status":
				return {
					status: "running", dataDir,
					rooms: db.prepare("SELECT count(*) c FROM rooms").get().c,
					memories: db.prepare("SELECT count(*) c FROM memories").get().c,
					vectors: vs.count ? db.prepare("SELECT count(*) c FROM memory_vectors").get().c : 0,
				};
			// rooms
			case "rooms.create": return rooms.createRoom(db, p);
			case "rooms.my": return rooms.getMyRoom(db, p);
			case "rooms.bind": return rooms.bindToRoom(db, p);
			case "rooms.members": return rooms.listMembers(db, p);
			case "rooms.get": return rooms.getRoom(db, p);
			case "rooms.update": return rooms.updateRoom(db, p);
			// memories（RPC 用 snake_case；repo 用 camelCase，这里归一化）
			case "memories.create": return memories.createMemory(db, dataDir, {
				token: p.token, clientId: p.client_id || p.clientId,
				contentType: p.content_type || p.contentType, text: p.text,
				mediaPath: p.media_path || p.mediaPath, recordedAt: p.recorded_at || p.recordedAt, transcript: p.transcript,
			}, {
				embedConfigured: () => { const c = aiConfigFor(db, p.token); return ai.isEnabled(c.select?.embed); },
				transcribeConfigured: () => { const c = aiConfigFor(db, p.token); return ai.isEnabled(c.select?.transcribe); },
				embed: (texts) => ai.embed(texts, aiConfigFor(db, p.token)),
				transcribe: (fp) => ai.transcribe(fp, "", aiConfigFor(db, p.token)),
				upsertVector: (id, rid, vec, text) => { try { vs.upsert(id, rid, vec, text); } catch {} },
				deleteVector: (id) => { try { vs.delete(id); } catch {} },
			});
			case "memories.update": return memories.updateMemory(db, {
				token: p.token, memoryId: p.id || p.memoryId,
				contentType: p.content_type || p.contentType, text: p.text,
				transcript: p.transcript, recordedAt: p.recorded_at || p.recordedAt, mediaPath: p.media_path || p.mediaPath,
			});
			case "memories.list": return memories.listMemories(db, { token: p.token, page: p.page, size: p.size, contentType: p.content_type || p.contentType });
			case "memories.get": return memories.getMemory(db, { token: p.token, memoryId: p.id || p.memoryId });
			case "memories.delete": return memories.deleteMemory(db, dataDir, { token: p.token, memoryId: p.id || p.memoryId }, { deleteVector: (id) => { try { vs.delete(id); } catch {} } });
			case "memories.upload": return memories.uploadMedia(db, dataDir, { token: p.token, filename: p.filename, buffer: Buffer.from(p.dataBase64 || "", "base64") });
			// search
			case "search.text": return { results: memories.searchMemories(db, { token: p.token, q: p.query || p.q, page: p.page, size: p.size }).items };
			case "search.semantic":
				try { return await searchRepo.semanticSearch(db, ai, vs, { ...p, config: aiConfigFor(db, p.token) }); }
				catch (e) { throw badGateway(`AI 服务不可用: ${e?.message || e}`); }
			case "search.related": return searchRepo.getRelated(db, ai, vs, { ...p, config: aiConfigFor(db, p.token) });
			// settings
			case "settings.get": return settings.getRoomSettings(db, p);
			case "settings.updateAi": return settings.updateAiConfig(db, p);
			case "settings.updateTheme": return settings.updateTheme(db, p);
			case "settings.toggleAi": return settings.toggleAi(db, p);
			case "settings.testChat":
				try { return { ok: true, response: String(await ai.testChat(aiConfigFor(db, p.token))).slice(0, 100) }; }
				catch (e) { throw badGateway(`AI 服务不可用: ${e?.message || e}`); }
			case "settings.testEmbed":
				try { return { ok: true, dimension: await ai.testEmbed(aiConfigFor(db, p.token)) }; }
				catch (e) { throw badGateway(`AI 服务不可用: ${e?.message || e}`); }
			case "settings.models": return { models: await ai.listModels(p.cap || "chat", aiConfigFor(db, p.token)) };
			// theme assets（背景图 / tabbar 图标）
			case "theme.upload": {
				const room = rooms.requireRoom(db, p.token);
				const file = memories.uploadMedia(db, dataDir, { token: p.token, filename: p.filename, buffer: Buffer.from(p.dataBase64 || "", "base64"), sub: `theme/${room.id}` });
				const url = `/only-room/media/${file.media_path}`;
				const merged = { ...settings.getRoomSettings(db, { roomId: room.id, token: p.token }).theme };
				if (p.kind === "background") merged.background_url = url;
				else if (typeof p.kind === "string" && p.kind.startsWith("icon:")) merged.icon_urls = { ...(merged.icon_urls || {}), [p.kind.slice(5)]: url };
				else if (p.kind === "icon") merged.icon_urls = { ...(merged.icon_urls || {}), [p.slot || "home"]: url };
				else if (p.kind === "delete") { /* 删除：见 theme.delete */ }
				settings.updateTheme(db, { roomId: room.id, token: p.token, theme: merged });
				return { ok: true, url };
			}
			case "theme.delete": {
				const room = rooms.requireRoom(db, p.token);
				// 从 theme 里移除引用并删文件
				const s = settings.getRoomSettings(db, { roomId: room.id, token: p.token });
				const merged = { ...s.theme };
				const target = p.url || "";
				if (merged.background_url === target) merged.background_url = null;
				if (merged.icon_urls) { for (const k of Object.keys(merged.icon_urls)) if (merged.icon_urls[k] === target) delete merged.icon_urls[k]; }
				settings.updateTheme(db, { roomId: room.id, token: p.token, theme: merged });
				try { memories.deleteMediaFile(dataDir, target.replace(/^\/only-room\/media\//, "")); } catch {}
				return { ok: true };
			}
			// users
			case "users.get": return users.getProfile(db, p);
			case "users.update": return users.updateProfile(db, p);
			case "users.avatar": return users.updateAvatar(db, dataDir, { ...p, buffer: Buffer.from(p.dataBase64 || "", "base64") });
			// moments
			case "moments.get": return moments.getMoments(db, { token: p.token, clientId: p.clientId, markRecordAnniversaries: p.mark !== false });
			// export
			case "export.json": return exportRepo.exportJson(db, { token: p.token });
			case "export.zip": return exportRepo.exportZip(db, dataDir, { token: p.token });
			default: throw new AppError(404, `unknown action "${action}"`);
		}
	}

	// 某些 action 返回 {filename, contentType, body}（导出）→ 写为附件。
	function isDownload(v) { return v && typeof v === "object" && Buffer.isBuffer(v.body) && v.filename; }

	// ---- 路由 1：/only-room/api（RPC）---------------------------------------
	const apiHandler = async (req, res) => {
		const trustedHosts = ctx.webRuntime?.trustedHosts ?? [];
		if (!isTrustedApiRequest(req, Array.isArray(trustedHosts) ? trustedHosts : [])) {
			writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "untrusted origin" } });
			return;
		}
		if (req.method !== "POST") {
			writeJson(res, 405, { ok: false, error: { code: "method-error", message: "use POST JSON {\"action\": ...}" } });
			return;
		}
		let payload;
		try { payload = await readJsonBody(req); }
		catch (e) { writeJson(res, 400, { ok: false, error: { code: "bad-request", message: String(e?.message || e) } }); return; }
		const action = typeof payload?.action === "string" ? payload.action : "";
		const params = (payload && typeof payload.params === "object" && payload.params) || {};
		try {
			const value = await dispatch(db, action, params);
			if (isDownload(value)) {
				writeBuffer(res, 200, value.body, {
					"content-type": value.contentType,
					"content-disposition": `attachment; filename="${value.filename}"`,
				});
			} else {
				writeJson(res, 200, { ok: true, value });
			}
		} catch (e) {
			const status = statusOf(e);
			writeJson(res, status, { ok: false, error: { code: "error", status, message: String(e?.message || e) } });
		}
	};

	// ---- 路由 2：/only-room/media/<relPath>（读媒体）-------------------------
	const mediaHandler = async (req, res) => {
		const trustedHosts = ctx.webRuntime?.trustedHosts ?? [];
		if (!isTrustedApiRequest(req, Array.isArray(trustedHosts) ? trustedHosts : [])) {
			writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "untrusted origin" } });
			return;
		}
		if (req.method !== "GET") { writeJson(res, 405, { ok: false, error: { code: "method-error", message: "use GET" } }); return; }
		const u = new URL(req.url, "http://x");
		const rel = decodeURIComponent(u.pathname.replace(/^\/only-room\/media\//, "")).replace(/^\/+/, "");
		const buf = memories.readMedia(dataDir, rel);
		if (!buf) { writeJson(res, 404, { ok: false, error: { code: "not-found", message: "media not found" } }); return; }
		writeBuffer(res, 200, buf, { "content-type": mimeOf(rel), "cache-control": "private, max-age=3600" });
	};

	ctx.effect(() => {
		ctx.webServer.register({ kind: "prefix", path: "/only-room/api", handler: apiHandler });
		ctx.webServer.register({ kind: "prefix", path: "/only-room/media", handler: mediaHandler });
		return undefined; // 无单独 disposer（见下面 dispose effect 统一 closeDb）
	}, "only-room-admin: /only-room/api + /only-room/media routes");

	ctx.effect(() => () => { closeDb(); ctx.logger?.info?.("[only-room-admin] disposed, db closed"); }, "only-room-admin: dispose closes the database");
}

const inject = ["webServer"];
export { Config, apply, inject, name };
