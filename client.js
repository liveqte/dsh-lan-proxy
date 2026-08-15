// dsh-plugin-lan-proxy — 浏览器端插件（手写 bundle，非构建产物）。
//
// 契约：classic script 调用 window.__ModuleLoader__.load({id, factory})；
// factory(require) 用同步 require 取 react / react/jsx-runtime（app-shell
// 静态词），返回 module.exports（{apply}）。dsh 的客户端 Loader 会像服务端
// 插件一样应用每个入口：apply(ctx) 里注册设置页「插件」区的 tab。
//
// 数据面：状态/日志/开关/重启全部走 /__lan-proxy/api/*（同一来源；该路由
// 由服务端插件同时注册在 dsh 自身 webserver 上，局域网访问经反代拦截提供）。
window.__ModuleLoader__.load({
	id: "dsh-plugin-lan-proxy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var _jsxRuntime = require("react/jsx-runtime");
		var React = require("react");
		var jsx = _jsxRuntime.jsx;
		var jsxs = _jsxRuntime.jsxs;
		var Fragment = _jsxRuntime.Fragment;

		var BASE = "/__lan-proxy";
		var MAX_LOG_ROWS = 400;

		// 官方主题 token（design-platform.css / base.css 定义在 body 上，本组件
		// 挂在官方设置页内，可直接引用；给 fallback 防止 token 未铺满）。
		// 代码字体栈刻意不要以裸 monospace 结尾——保证中文环境有可用回退字体。
		var FONT = "var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif)";
		var MONO = "var(--ds-font-family-code, 'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei')";
		var C = {
			primary: "var(--dsw-alias-label-primary, #f9fafb)",
			secondary: "var(--dsw-alias-label-secondary, #cfd3d6)",
			tertiary: "var(--dsw-alias-label-tertiary, #adb2b8)",
			caption: "var(--dsw-alias-label-caption, #81858c)",
			link: "var(--dsw-alias-state-business-primary, #679efe)",
			green: "var(--dsw-alias-state-success-primary, #22c55e)",
			red: "var(--dsw-alias-state-error-primary, #f25a5a)",
			amber: "var(--dsw-alias-state-warn-primary, #f59e0b)",
			border: "var(--dsw-alias-border-l2, rgba(255,255,255,.12))",
			borderSoft: "var(--dsw-alias-border-l1, rgba(255,255,255,.06))",
			codeBg: "var(--dsw-alias-markdown-code-block, rgba(0,0,0,.35))",
			inlineCodeBg: "var(--dsw-alias-markdown-inline-code, rgba(255,255,255,.08))",
			ghostBg: "var(--dsw-alias-button-ghost-active-fill, rgba(255,255,255,.08))"
		};

		// ── 组件 ───────────────────────────────────────────────────────────

		function LanProxySection() {
			var state = React.useState(null);
			var status = state[0];
			var setStatus = state[1];
			var state2 = React.useState([]);
			var logs = state2[0];
			var setLogs = state2[1];
			var state3 = React.useState(null);
			var err = state3[0];
			var setErr = state3[1];
			var state4 = React.useState(false);
			var busy = state4[0];
			var setBusy = state4[1];
			var lastTs = React.useRef(0);
			var pState = React.useState("");
			var listenPortVal = pState[0];
			var setListenPortVal = pState[1];
			var pState2 = React.useState("");
			var upstreamPortVal = pState2[0];
			var setUpstreamPortVal = pState2[1];
			var configDirty = React.useRef(false);

			React.useEffect(function () {
				var alive = true;
				var tick = async function () {
					try {
						var r = await fetch(BASE + "/api/status");
						if (r.ok) {
							var d = await r.json();
							if (alive) {
								setStatus(d);
								setErr(null);
								if (!configDirty.current) {
									setListenPortVal(String(d.listenPort));
									setUpstreamPortVal(String(d.upstreamPort));
								}
							}
						} else if (alive) {
							setErr("状态读取失败 HTTP " + r.status);
						}
						var lr = await fetch(BASE + "/api/logs?since=" + lastTs.current);
						if (lr.ok) {
							var ld = await lr.json();
							if (ld.lines && ld.lines.length && alive) {
								setLogs(function (prev) {
									return prev.concat(ld.lines).slice(-MAX_LOG_ROWS);
								});
								lastTs.current = ld.lines.reduce(function (m, l) { return Math.max(m, l.ts); }, lastTs.current);
							}
						}
					} catch (e) {
						if (alive) setErr(String((e && e.message) || e));
					}
				};
				tick();
				var iv = setInterval(tick, 2000);
				return function () {
					alive = false;
					clearInterval(iv);
				};
			}, []);

			function clearView() {
				setLogs([]);
				lastTs.current = Date.now();
			}

			async function toggle(next) {
				if (busy) return;
				setBusy(true);
				setErr(null);
				try {
					var r = await fetch(BASE + "/api/set-enabled", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ enabled: next })
					});
					var d = await r.json();
					if (!d.ok) {
						setErr(d.error || "切换失败（HTTP " + r.status + "）");
						setStatus(function (s) { return s ? Object.assign({}, s, { enabled: !next }) : s; });
					}
				} catch (e) {
					setErr("切换失败：" + String((e && e.message) || e));
				}
				setBusy(false);
			}

			async function restart() {
				if (busy) return;
				setBusy(true);
				setErr(null);
				try {
					var r = await fetch(BASE + "/api/restart", { method: "POST" });
					var d = await r.json();
					if (!d.ok) setErr(d.error || "重启失败（HTTP " + r.status + "）");
				} catch (e) {
					setErr("重启失败：" + String((e && e.message) || e));
				}
				setBusy(false);
			}

			function onPortChange(setter, val) {
				configDirty.current = true;
				setter(val.replace(/[^0-9]/g, ""));
			}

			async function saveConfig() {
				if (busy) return;
				setBusy(true);
				setErr(null);
				var lp = parseInt(listenPortVal, 10);
				var up = parseInt(upstreamPortVal, 10);
				if (!(lp >= 1 && lp <= 65535) || !(up >= 1 && up <= 65535)) {
					setErr("端口须为 1-65535 的整数");
					setBusy(false);
					return;
				}
				try {
					var r = await fetch(BASE + "/api/set-config", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ listenPort: lp, upstreamPort: up })
					});
					var d = await r.json();
					if (!d.ok) {
						setErr(d.error || "保存失败（HTTP " + r.status + "）");
					} else {
						configDirty.current = false;
					}
				} catch (e) {
					setErr("保存失败：" + String((e && e.message) || e));
				}
				setBusy(false);
			}

			// ── 渲染 ───────────────────────────────────────────────────────

			var styles = {
				wrap: { display: "flex", flexDirection: "column", gap: 12, fontSize: 13, lineHeight: 1.6, color: C.primary, fontFamily: FONT },
				row: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
				sw: { display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" },
				swInput: { width: 34, height: 18, appearance: "none", background: "rgba(127,127,127,.35)", borderRadius: 9, position: "relative", outline: "none", margin: 0, cursor: "pointer", transition: "background .15s" },
				swOn: { background: C.green },
				swKnob: { position: "absolute", width: 14, height: 14, borderRadius: "50%", background: "#fff", top: 2, left: 2, pointerEvents: "none", transition: "left .15s" },
				swKnobOn: { left: 18 },
				dot: { width: 9, height: 9, borderRadius: "50%", display: "inline-block" },
				dotOn: { background: C.green, boxShadow: "0 0 6px rgba(34,197,94,.45)" },
				dotOff: { background: C.red },
				dotMid: { background: C.amber },
				kbd: { background: C.inlineCodeBg, border: "1px solid " + C.border, borderRadius: 4, padding: "1px 6px", fontFamily: MONO, fontSize: 12, color: C.primary },
muted: { color: C.tertiary, fontSize: 12 },
			warn: { color: C.amber, fontSize: 12, fontWeight: 600 },
			err: { color: C.red, fontSize: 12 },
			input: { background: "var(--dsw-specific-input-major, rgba(255,255,255,.12))", border: "1px solid " + C.border, borderRadius: 6, padding: "4px 8px", color: C.primary, fontFamily: MONO, fontSize: 12, width: 90, outline: "none", transition: "border-color .15s, box-shadow .15s, background .15s" },
				logs: { background: C.codeBg, border: "1px solid " + C.border, borderRadius: 8, padding: "8px 10px", overflow: "auto", maxHeight: 260, minHeight: 60, fontFamily: MONO, fontSize: 12, lineHeight: 1.5, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", color: C.secondary },
				lnInfo: { color: C.secondary },
				lnWarn: { color: C.amber },
				lnError: { color: C.red },
				lnT: { color: C.caption },
				btn: { background: C.ghostBg, color: C.primary, border: "1px solid " + C.border, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12, fontFamily: FONT },
				btnDisabled: { opacity: .5, cursor: "default" },
				a: { color: C.link, textDecoration: "none" },
card: { border: "1px solid " + C.borderSoft, borderRadius: 8, padding: "10px 12px" },
			title: { fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: C.secondary, margin: "0 0 6px", fontWeight: 600 },
			pageTitle: { fontSize: 18, fontWeight: 600, color: C.primary, margin: 0 },
			pageIntro: { fontSize: 13, color: C.tertiary, margin: "2px 0 14px" }
			};

			var st = status;
			var stateText = !st ? "读取中…" : st.state === "listening" ? "运行中" : st.state === "starting" ? "启动中…" : st.state === "stopped" ? "已停止" : "错误";
			var stateDot = !st ? styles.dotMid : st.state === "listening" ? styles.dotOn : st.state === "error" ? styles.dotOff : styles.dotMid;

			var addrRows = null;
			if (st && st.lanAddrs && st.lanAddrs.length) {
				addrRows = st.lanAddrs.map(function (a, i) {
					return jsx("div", { key: "a" + i, style: styles.row, children: jsx("a", { href: "http://" + a + ":" + st.listenPort + "/", style: styles.a, children: "http://" + a + ":" + st.listenPort + "/" }) });
				});
			} else if (st) {
				addrRows = jsx("div", { style: styles.muted, children: "（未检测到 IPv4 局域网地址）" });
			}

			var probeNode = null;
			if (st && st.probe) {
				var p = st.probe;
				probeNode = p.ok
					? jsxs("span", { children: [jsx("span", { style: Object.assign({}, styles.dot, styles.dotOn) }), " 上游可达（HTTP " + p.status + "，" + p.ms + " ms）"] })
					: jsxs("span", { children: [jsx("span", { style: Object.assign({}, styles.dot, styles.dotOff) }), " 上游不可达：" + (p.error || ("HTTP " + p.status)) + (st.state === "listening" ? "（反代在跑仍不可达，可能端口不一致）" : "")] });
			}

			var logRows = (logs.length ? logs : [{ ts: 0, level: "info", msg: st ? "（暂无日志，等待活动…）" : "加载中…" }]).map(function (l, i) {
				var cls = l.level === "warn" ? styles.lnWarn : l.level === "error" ? styles.lnError : styles.lnInfo;
				return jsxs("div", { key: "l" + i, style: cls, children: [
					jsx("span", { style: styles.lnT, children: l.ts ? "[" + fmt(l.ts) + "] " : "" }),
					l.msg
				] });
			});

return jsx("div", { style: styles.wrap, children: [
				jsx("h2", { style: styles.pageTitle, children: "局域网反代" }),
				jsx("p", { style: styles.pageIntro, children: "把 dsh 的 Web UI 通过 0.0.0.0 反代暴露到局域网。监听开放期间无密码保护，请仅在可信网络中使用。" }),
				jsx("div", { style: styles.card, children: [
				jsxs("div", { style: styles.row, children: [
				jsx("span", { style: styles.title, children: "监听局域网访问" }),
				jsx("span", { style: styles.warn, children: "（无密码保护，仅安全网络环境下使用）" })
			] }),
					jsxs("div", { style: styles.row, children: [
						jsx("label", { style: styles.sw, children: [
							jsx("span", { style: Object.assign({}, styles.swInput, status && status.enabled ? styles.swOn : null, { position: "relative", display: "inline-block" }), onClick: function (e) { e.preventDefault(); toggle(!(status && status.enabled)); }, children: jsx("span", { style: Object.assign({}, styles.swKnob, status && status.enabled ? styles.swKnobOn : null) }) }),
							jsx("span", { style: { fontSize: 13, cursor: "pointer" }, onClick: function () { toggle(!(status && status.enabled)); }, children: status ? (status.enabled ? "开（局域网可访问）" : "关（仅本机可访问）") : "读取中…" })
						] }),
						jsx("span", { style: Object.assign({}, styles.dot, stateDot) }),
						jsx("span", { children: stateText }),
						jsx("span", { style: styles.muted, children: status ? "运行时开关即时生效，无需重启 dsh" : "" })
					] }),
					err ? jsx("div", { style: styles.err, children: err }) : null
				] }),
				jsx("div", { style: styles.card, children: [
					jsx("div", { style: styles.title, children: "运行状态" }),
					jsxs("div", { style: styles.row, children: [
						jsx("span", { children: "监听：" }),
						jsx("code", { style: styles.kbd, children: st ? st.listenHost + ":" + st.listenPort : "…" }),
						jsx("span", { children: "　上游：" }),
						jsx("code", { style: styles.kbd, children: st ? st.upstream : "…" }),
						jsx("span", { style: styles.muted, children: st ? "· 启动于 " + (st.startedAt ? fmt(st.startedAt) : "—") + " · WS 升级 " + st.upgrades + " 次" : "" })
					] }),
					jsxs("div", { style: styles.row, children: [
						jsx("button", { style: Object.assign({}, styles.btn, busy ? styles.btnDisabled : null), onClick: restart, disabled: busy, children: "重启反代" }),
						jsx("span", { style: styles.muted, children: "（仅本机可操作）" })
					] })
				] }),
jsx("div", { style: styles.card, children: [
				jsx("div", { style: styles.title, children: "端口配置" }),
				jsxs("div", { style: styles.row, children: [
					jsx("label", { children: "监听端口（0.0.0.0）" }),
					jsx("input", { className: "lanproxy-port-input", style: styles.input, type: "text", inputMode: "numeric", value: listenPortVal, onChange: function (e) { onPortChange(setListenPortVal, e.target.value); }, placeholder: "3080" }),
					jsx("span", { children: "　上游端口（127.0.0.1）" }),
					jsx("input", { className: "lanproxy-port-input", style: styles.input, type: "text", inputMode: "numeric", value: upstreamPortVal, onChange: function (e) { onPortChange(setUpstreamPortVal, e.target.value); }, placeholder: "3080" }),
					jsx("button", { style: Object.assign({}, styles.btn, busy ? styles.btnDisabled : null), onClick: saveConfig, disabled: busy, children: "保存并应用" })
				] }),
				jsx("div", { style: styles.muted, children: "上游端口默认取 dsh 实际监听端口；修改后立即重启反代生效（保存仅本机可操作）" })
			] }),
			jsx("div", { style: styles.card, children: [
				jsx("div", { style: styles.title, children: "局域网访问地址" }),
					addrRows || jsx("div", { style: styles.muted, children: "读取中…" })
				] }),
				jsx("div", { style: styles.card, children: [
					jsx("div", { style: styles.title, children: "上游可达性" }),
					probeNode || jsx("span", { style: styles.muted, children: "读取中…" })
				] }),
				jsx("div", { style: styles.card, children: [
					jsxs("div", { style: styles.row, children: [
						jsx("div", { style: styles.title, children: "反代服务启动日志" }),
						jsx("button", { style: styles.btn, onClick: clearView, children: "清空视图" })
					] }),
					jsx("div", { style: styles.logs, children: logRows })
				] }),
				jsx("div", { style: styles.muted, children: "持久化默认值在 ~/.dsh/profiles/web/cordis.patch.yml 的 lan-proxy 行（enabled）；开关与状态均已嵌入本设置页。" })
			] });
		}

		function fmt(ts) {
			var d = new Date(ts);
			return d.toLocaleString("zh-CN", { hour12: false });
		}

		// 端口输入框的 hover/focus 态（inline style 写不了伪类）：
		// 用官方交互 token 让输入框明显可编辑（hover 提亮、focus 品牌色描边）。
		var INPUT_CSS_ID = "lanproxy-input-css";
		function injectInputCss() {
			if (document.getElementById(INPUT_CSS_ID)) return;
			var style = document.createElement("style");
			style.id = INPUT_CSS_ID;
			style.textContent =
				".lanproxy-port-input:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.16))}" +
				".lanproxy-port-input:focus{background:var(--dsw-specific-input-major,rgba(255,255,255,.12));border-color:var(--dsw-alias-state-business-primary,#679efe);box-shadow:0 0 0 2px rgba(103,158,254,.25)}";
			document.head.appendChild(style);
		}

		// ── 插件激活 ───────────────────────────────────────────────────────

		// cordis fiber inject：本插件需要用到的【服务名】。ctx.slots 由
		// dsh-client-runtime 的 SlotRegistry（服务名 "slots"）提供。
		var inject = ["slots"];

		function apply(ctx) {
			injectInputCss();
			// 一级设置项：与「通用设置 / 模型 / 插件 / Agent 预设」平级，
			// 不再是「插件」区里的二级 tab。
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "lan-proxy",
					order: 25,
					label: function () { return "局域网反代"; }
				}, LanProxySection);
			});
		}

		exports.apply = apply;
		exports.inject = inject;

		return module.exports;
	}
});
