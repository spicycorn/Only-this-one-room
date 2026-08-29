// 只此一间 v2 — DSH Cordis 插件（client half）。
// settings → "只此一间" 面板：快速记录、最近记忆、房间与绑定、AI 配置（DSH 格式）、主题与开关、数据导出。
// 所有数据操作都走 /only-room/api RPC（host 半在 index.js）；媒体文件走 /only-room/media/<path>。
// 不再有 FastAPI 后端：AI 网关在 DSH 进程内按需调用本地/远端模型。

window.__ModuleLoader__.load({
	id: "only-room-admin",
	factory: (require) => {
		const react = require("react");
		const el = (...args) => react.createElement(...args);

		const name = "only-room-admin";
		const inject = ["slots"]; // 只需要 slots（settings.section）
		const CLIENT_ID = "dsh-admin"; // 面板自身的稳定匿名 ID（与任意客户端设备同一身份机制）
		const LS_TOKEN = "only_room_token";

		function getToken() { return localStorage.getItem(LS_TOKEN) || ""; }
		function saveToken(t) { localStorage.setItem(LS_TOKEN, t || ""); }

		// ---- RPC 原语：所有数据操作都走它。自动带 token；返回 host 解包后的 value，出错抛 Error。 ----
		async function rpc(action, params = {}) {
			const body = Object.assign({}, params);
			if (!body.token && getToken()) body.token = getToken();
			if (!body.client_id && !body.clientId) { body.client_id = body.client_id || CLIENT_ID; } // rooms.my 等需要
			let resp;
			try {
				resp = await fetch("/only-room/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, params: body }) });
			} catch { throw new Error("无法连接 DSH 宿主（/only-room/api 不可达）"); }
			let data = null;
			try { data = await resp.json(); } catch {}
			if (data && data.ok) return data.value;
			const detail = (data && data.error && (data.error.detail || data.error.message)) || (data && data.error) || `RPC ${action} 失败`;
			throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
		}

		// ---- 下载原语：导出等二进制响应，直接读 blob 触发浏览器下载。 ----
		async function download(action, params = {}) {
			const body = Object.assign({}, params);
			if (!body.token && getToken()) body.token = getToken();
			const resp = await fetch("/only-room/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, params: body }) });
			if (!resp.ok) { let d; try { d = await resp.json(); } catch {} throw new Error((d && d.error && (d.error.detail || d.error.message)) || `HTTP ${resp.status}`); }
			const blob = await resp.blob();
			const cd = resp.headers.get("content-disposition") || "";
			const m = /filename="([^"]*)"/.exec(cd);
			const filename = (m && m[1]) || `only_room_${action.replace(/\./g, "_")}`;
			const a = document.createElement("a");
			a.href = URL.createObjectURL(blob);
			a.download = filename;
			document.body.appendChild(a); a.click();
			setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
			return { ok: true };
		}

		function mediaUrl(p) { return p ? `/only-room/media/${String(p).replace(/^\/+/, "")}` : ""; }

		// ---- 文件 → base64（上传走 RPC，不走 multipart）----
		function fileToBase64(file) {
			return new Promise((resolve, reject) => {
				const fr = new FileReader();
				fr.onload = () => { const s = String(fr.result || ""); const i = s.indexOf(","); resolve(i >= 0 ? s.slice(i + 1) : s); };
				fr.onerror = () => reject(fr.error || new Error("read file failed"));
				fr.readAsDataURL(file);
			});
		}
		function pickFile(accept, onFile) {
			const input = document.createElement("input");
			input.type = "file"; input.accept = accept || "image/*";
			input.onchange = async () => { const f = input.files && input.files[0]; if (!f) return; onFile(f); input.remove(); };
			input.click();
		}

		function fmtTime(iso) { if (!iso) return ""; const d = new Date(iso); return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
		function SectionTitle(text) { return el("div", { className: "or-title" }, text); }
		function Inp(props) { const type = (props && props.type) || "text"; const rest = Object.assign({}, props); delete rest.type; return el("input", Object.assign({ type }, rest)); }
		function Sel(options, value, onChange) { return el("select", { value: value == null ? "" : value, onChange: (e2) => onChange(e2.target.value) }, options.map(([v, l]) => el("option", { key: v, value: v }, l))); }
		function Row(children) { return el("div", { className: "or-row" }, children); }
		function Btn(label, onClick, disabled) { return el("button", { type: "button", onClick, disabled: !!disabled || undefined }, label); }

		const PRESETS = [["cute", "🌸 可爱"], ["dark", "🌙 暗黑"], ["fresh", "🍃 清新"]];
		const ICON_SLOTS = [["home", "首页"], ["search", "搜索"], ["about", "关于"], ["settings", "设置"]];
		const APIS = [["openai", "OpenAI 兼容"], ["openai-responses", "Responses"], ["anthropic", "Anthropic"], ["google", "Google"], ["google-vertex", "Vertex"]];

		// ---- DSH AI 配置默认值 ----
		function defaultAiConfig() {
			return { providers: {}, select: { chat: { provider: "", model: "" }, embed: { provider: "", model: "" }, transcribe: { provider: "", model: "" } } };
		}
		function normProvider(p) { return { baseURL: (p && p.baseURL) || "", apiKey: (p && p.apiKey) || "", api: (p && p.api) || "openai", models: (p && p.models) || [] }; }

		function OnlyRoomSection() {
			const [proc, setProc] = react.useState({ status: "unknown" });
			const [room, setRoom] = react.useState(null); // {id,name,members:[...]} | null=未创建
			const [recent, setRecent] = react.useState([]);
			const [aiCfg, setAiCfg] = react.useState(defaultAiConfig());
			const [theme, setTheme] = react.useState({ preset: "cute", primary_color: null, background_url: null, icon_urls: null });
			const [aiEnabled, setAiEnabled] = react.useState(true);
			const [quickText, setQuickText] = react.useState("");
			const [msg, setMsg] = react.useState("");
			const [newRoomName, setNewRoomName] = react.useState("只此一间");
			const [joinToken, setJoinToken] = react.useState("");
			const [provKey, setProvKey] = react.useState("ollama"); // 当前编辑的 provider 键
			react.useEffect(() => { void refreshAll(); }, []); // eslint-disable-line

			function flash(m) { setMsg(m); }
			function ok(m) { setMsg("✓ " + m); }
			function fail(e) { setMsg("✗ " + ((e && e.message) || String(e))); }

			async function loadStatus() { try { const s = await rpc("status", {}); setProc(s || { status: "unknown" }); } catch { setProc({ status: "unknown" }); } }

			async function loadRoom() {
				// 1) 本设备身份已进房 → 取房间信息（顺带拿权威 token）
				try { const r = await rpc("rooms.my", { clientId: CLIENT_ID }); if (r && r.id) { saveToken(r.api_token || getToken()); const roomObj = { id: r.id, name: r.name, anniversary_date: r.anniversary_date || null, members: [] }; await withMembers(roomObj); setRoom(roomObj); return roomObj; } } catch {}
				// 2) 持有 token（成员设备）→ 用 token 直接进
				if (getToken()) {
					try { const r = await rpc("rooms.get", {}); if (r && r.id) { const roomObj = { id: r.id, name: r.name, anniversary_date: r.anniversary_date || null, members: [] }; await withMembers(roomObj); setRoom(roomObj); return roomObj; } } catch {}
				}
				setRoom(null); return null;
			}
			// rooms.* 的 roomOut 只给 member_count，成员明细要单独调 rooms.members
			async function withMembers(roomObj) { try { const m = await rpc("rooms.members", {}); if (m && Array.isArray(m.members)) roomObj.members = m.members; } catch {} }

			async function refreshAll() {
				await loadStatus();
				const roomData = await loadRoom();
				if (!roomData) return;
				loadRecent(); loadRoomSettings();
			}

			async function loadRecent() { try { const d = await rpc("memories.list", { page: 1, size: 5 }); setRecent((d && d.items) || []); } catch {} }
			async function loadRoomSettings() {
				try {
					const s = await rpc("settings.get", {});
					if (s) {
						setTheme(s.theme || { preset: "cute", primary_color: null, background_url: null, icon_urls: null });
						setAiEnabled(s.ai_enabled !== false);
						if (s.ai_config && (s.ai_config.providers || s.ai_config.select)) {
							const cfg = Object.assign(defaultAiConfig(), s.ai_config);
							if (!cfg.select) cfg.select = defaultAiConfig().select;
							setAiCfg(cfg);
							const keys = Object.keys(cfg.providers || {});
							if (keys.length) setProvKey(keys[0]);
						}
					}
				} catch {}
			}

			// ---- 快速记录 ----
			function quickRecord() {
				const text = (quickText || "").trim(); if (!text) return;
				void rpc("memories.create", { content_type: "text", text }).then(() => setQuickText("")).then(() => loadRecent()).catch((e) => fail(e));
			}

			// ---- 房间 ----
			function createRoom() { void rpc("rooms.create", { clientId: CLIENT_ID, name: (newRoomName || "").trim() }).then(() => refreshAll()).catch((e) => fail(e)); }
			function bindRoom() {
				const token = (joinToken || "").trim();
				if (!token) { fail("请粘贴另一半发给你的 Token"); return; }
				void rpc("rooms.bind", { token, clientId: CLIENT_ID }).then(() => {
					saveToken(token); // bind 响应不带 token，用刚验证过的那份
					setJoinToken("");
					ok("已加入房间");
					refreshAll();
				}).catch((e) => fail(e));
			}
			function copyToken() { const t = getToken(); void navigator.clipboard?.writeText(t).then(() => ok("Token 已复制")).catch(() => {}); }

			// ---- 主题 ----
			function persistTheme(merged) { setTheme(merged); void rpc("settings.updateTheme", { theme: merged }).then(() => ok("主题已保存")).catch((e) => fail(e)); }
			function setPreset(preset) { persistTheme(Object.assign({}, theme, { preset })); }
			function setPrimaryColor(c) { persistTheme(Object.assign({}, theme, { primary_color: (c || "").trim() || null })); }
			function setBackground(url) { persistTheme(Object.assign({}, theme, { background_url: url || null })); }
			function setIconSlot(slot, url) { const icon_urls = Object.assign({}, theme.icon_urls || {}); if (url) icon_urls[slot] = url; else delete icon_urls[slot]; persistTheme(Object.assign({}, theme, { icon_urls })); }

			function uploadAsset(kind, slot) {
				pickFile("image/png,image/jpeg,image/webp,image/gif", async (file) => {
					try {
						const dataBase64 = await fileToBase64(file);
						const r = await rpc("theme.upload", { filename: file.name, dataBase64, kind, slot });
						ok("素材已上传"); loadRoomSettings();
					} catch (e) { fail(e); }
				});
			}
			function deleteAsset(url) { void rpc("theme.delete", { url }).then(() => { ok("素材已删除"); loadRoomSettings(); }).catch((e) => fail(e)); }

			function toggleAI() { const next = !aiEnabled; void rpc("settings.toggleAi", { enabled: next }).then(() => { setAiEnabled(next); ok(next ? "AI 已开启" : "AI 已关闭（纯存储 + 时间线）"); }).catch((e) => fail(e)); }

			// ---- AI 配置（DSH 格式）----
			function setProvField(key, field, value) { setAiCfg((cur) => { const providers = Object.assign({}, cur.providers || {}); providers[key] = Object.assign({}, normProvider(providers[key]), { [field]: value }); return { providers, select: cur.select }; }); }
			function addProvider() { const key = provKey && !aiCfg.providers[provKey] ? provKey : "p" + (Object.keys(aiCfg.providers).length + 1); setAiCfg((cur) => ({ providers: Object.assign({}, cur.providers, { [key]: normProvider(null) }), select: cur.select })); setProvKey(key); }
			function setSelect(part, field, value) { setAiCfg((cur) => ({ providers: cur.providers, select: Object.assign({}, cur.select, { [part]: Object.assign({}, cur.select[part] || {}, { [field]: value }) }) })); }
			function saveAiCfg() { void rpc("settings.updateAi", { config: aiCfg }).then(() => ok("AI 配置已保存")).catch((e) => fail(e)); }
			function testChat() { void rpc("settings.testChat", {}).then((r) => ok("chat: " + (r && r.response ? r.response.slice(0, 60) : "ok"))).catch((e) => fail(e)); }
			function testEmbed() { void rpc("settings.testEmbed", {}).then((r) => ok(`embed: ${r && r.dimension != null ? "维度 " + r.dimension : "ok"}`)).catch((e) => fail(e)); }

			// ---- 导出 ----
			function dlExport(action) { void download(action, {}).then(() => ok("导出已开始")).catch((e) => fail(e)); }

			function modelSelectRow(part, label) {
				const sel = (aiCfg.select && aiCfg.select[part]) || { provider: "", model: "" };
				const provName = sel.provider;
				const models = provName && aiCfg.providers && aiCfg.providers[provName] ? (aiCfg.providers[provName].models || []) : [];
				const modelCtl = models.length > 0
					? Sel([["", "(选择)"], ...models.map((m) => [m, m])], sel.model, (v) => setSelect(part, "model", v))
					: Inp({ value: sel.model, onChange: (e) => setSelect(part, "model", e.target.value), placeholder: "模型名" });
				return Row(el("b", { style: { display: "inline-block", width: 52 } }, label + ":"),
					Sel([["", "(未启用)"], ...provKeys.map((k) => [k, k])], sel.provider, (v) => setSelect(part, "provider", v)),
					el(" "),
					modelCtl);
			}

			const running = proc.status === "running";
			const provKeys = Object.keys(aiCfg.providers || {});
			const curProv = aiCfg.providers && aiCfg.providers[provKey] ? normProvider(aiCfg.providers[provKey]) : normProvider(null);
			const selectParts = [["chat", "Chat"], ["embed", "Embed"], ["transcribe", "Transcribe"]];

			return el("div", { className: "or-panel" },
				el("div", null,
					el("span", { style: { fontWeight: 600 } }, "💕 只此一间"),
					` · 状态 ${running ? "运行中 ●" : "○"}`
				),

				msg && el("div", { style: { opacity: 0.85, fontSize: 12 } }, msg),

				SectionTitle("快速记录"),
				Inp({ value: quickText, onChange: (e) => setQuickText(e.target.value), placeholder: "说点什么..." }),
				el(" ", null), Btn("记一笔", quickRecord),

				recent.length > 0 && SectionTitle("最近记忆"),
				...recent.map((m) => {
					const t = (m.text || "").trim();
					const summary = t ? " · “" + t.slice(0, 48) + (t.length > 48 ? "…" : "") : "";
					const mark = m.content_type === "image" ? "🖼️" : m.content_type === "audio" ? "🎤" : "";
					return el("div", { key: m.id, style: { fontSize: 13, display: "flex", alignItems: "center", gap: 6 } },
						m.content_type === "image" && m.media_path ? el("img", { src: mediaUrl(m.media_path), style: { width: 28, height: 28, objectFit: "cover", borderRadius: 4, flex: "0 0 auto" } }) : null,
						`${fmtTime(m.recorded_at)} ${mark}${summary}`);
				}),

				SectionTitle("房间与绑定"),
				room === null && el("div", { style: { fontSize: 13 } },
					Inp({ value: newRoomName, onChange: (e) => setNewRoomName(e.target.value), placeholder: "房间名" }),
					el(" ", null), Btn("创建房间（我是房主）", createRoom),
					el("div", { style: { margin: "8px 0", fontSize: 12, opacity: 0.7 } }, "—— 或加入已有房间 ——"),
					Inp({ value: joinToken, onChange: (e) => setJoinToken(e.target.value), placeholder: "粘贴另一半发给你的 Token（64 位）" }),
					el(" ", null), Btn("加入房间", bindRoom)
				),
				room !== null && el("div", { style: { fontSize: 13 } },
					el("b", null, room.name || ""), ` · ${((room.members || []).length)} 位成员`,
					room.anniversary_date ? ` · 💕 纪念日 ${room.anniversary_date}` : null,
					...(room.members || []).map((u) => el("span", { key: u.nickname + (u.role || "") }, ` [${u.nickname || "?"}${u.role === "owner" ? "(我)" : ""}]`))
				),
				getToken() && el("div", { style: { fontSize: 12, opacity: 0.8 } },
					el("code", null, getToken().slice(0, 12) + "…"), el(" ", null), Btn("复制 Token（发给另一半）", copyToken)
				),

				SectionTitle("AI 配置（DSH 格式）"),
				Row(el("b", { style: { display: "inline-block", width: 52 } }, "Provider:"),
					Inp({ value: provKey, onChange: (e) => setProvKey(e.target.value), placeholder: "provider 键名（如 ollama）", style: { width: 120 } }),
					el(" "), Btn("添加 Provider", addProvider),
					provKeys.length > 0 && el(" ", null) && el("code", null, "已有: " + provKeys.join(", "))),
				provKey && el("div", { style: { fontSize: 13, paddingLeft: 8 } },
					Row(el("b", { style: { display: "inline-block", width: 52 } }, "baseURL:"),
						Inp({ value: curProv.baseURL, onChange: (e) => setProvField(provKey, "baseURL", e.target.value), placeholder: "http://localhost:11434/v1" })),
					Row(el("b", { style: { display: "inline-block", width: 52 } }, "apiKey:"),
						Inp({ value: curProv.apiKey, onChange: (e) => setProvField(provKey, "apiKey", e.target.value), placeholder: "sk-...（本地模型留空）", type: "password" })),
					Row(el("b", { style: { display: "inline-block", width: 52 } }, "api:"),
						Sel(APIS, curProv.api, (v) => setProvField(provKey, "api", v))),
					Row(el("b", { style: { display: "inline-block", width: 52 } }, "models:"),
						Inp({ value: (curProv.models || []).join(", "), onChange: (e) => setProvField(provKey, "models", e.target.value.split(",").map((s) => s.trim()).filter(Boolean)), placeholder: "qwen2.5, nomic-embed-text" }))),
				el("div", { style: { fontSize: 13, paddingLeft: 8 } },
					...selectParts.map(([part, label]) => modelSelectRow(part, label))
				),
				Row(Btn("测试 Chat", testChat), el(" "), Btn("测试 Embed", testEmbed), el(" "), Btn("保存 AI 配置", saveAiCfg)),

				SectionTitle("主题与开关"),
				Row(...PRESETS.map(([key, label]) => Btn(label, () => setPreset(key), false)), el(" "), el("span", { style: { fontSize: 12, opacity: 0.7 } }, `当前：${theme.preset || "cute"}`)),
				Row(el("b", { style: { display: "inline-block", width: 52 } }, "主色:"),
					Inp({ value: theme.primary_color || "", onChange: (e) => setPrimaryColor(e.target.value), placeholder: "#ff6b9d（留空用预设）" })),
				Row(el("b", { style: { display: "inline-block", width: 52 } }, "背景图:"),
					theme.background_url
						? el("span", null, el("img", { src: mediaUrl(theme.background_url), style: { width: 34, height: 22, objectFit: "cover", verticalAlign: "middle", borderRadius: 4, border: "1px solid #8884" } }), el(" "), Btn("删除", () => deleteAsset(theme.background_url)))
						: Btn("上传背景图", () => uploadAsset("background"))
				),
				...ICON_SLOTS.map(([slot, label]) => {
					const url = (theme.icon_urls || {})[slot];
					return Row(el("b", { style: { display: "inline-block", width: 52 } }, label + ":"),
						url
							? el("span", null, el("img", { src: mediaUrl(url), style: { width: 20, height: 20, objectFit: "contain", verticalAlign: "middle" } }), el(" "), Btn("删除", () => deleteAsset(url)))
							: Btn("上传图标", () => uploadAsset("icon", slot)));
				}),
				Row(el("b", { style: { display: "inline-block", width: 52 } }, "AI 开关:"),
					Btn(aiEnabled ? "已开启（点击关闭）" : "已关闭（点击开启）", toggleAI)),

				SectionTitle("数据导出"),
				Row(Btn("下载 JSON（结构化）", () => dlExport("export.json")), el(" "), Btn("备份 ZIP（SQLite+媒体）", () => dlExport("export.zip")))
			);
		}

		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "only-room-admin",
				order: 60,
				label: () => "只此一间"
			}, (props) => el(OnlyRoomSection)));
		}

		return { name, inject, apply };
	}
});
