// dsh-plugin-lan-proxy — 把 dsh 的回环 Web UI 通过 0.0.0.0 反代暴露到局域网。
//
// 设计：
//   * 反代采用协议层适配（RFC6455 手工帧编解码 + Host/Origin 改写 +
//     crypto.randomUUID polyfill 注入），作为插件内嵌在同一进程里，随 dsh
//     启停，无端口竞争。
//   * 插件 Config 提供「监听局域网访问」开关（enabled，默认关），页面上的开关
//     即时写运行时文件 lan-proxy.runtime.json 并热启停，无需重启 dsh；
//     cordis.patch.yml 里的 enabled 是默认值（持久化）。
//   * 开关/状态/日志全部嵌入 dsh 设置页的 tab（见 client.js），
//     数据面走 statusPath 下的 JSON API（默认 /__lan-proxy/api/*）：
//       - 本机 127.0.0.1 直达 dsh 时由插件注册的 webServer 路由提供；
//       - 局域网访问时由反代自身拦截提供。
//   * 开关与重启接口仅限回环地址调用；局域网只读状态与日志。
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";

const name = "lan-proxy";
/** 需要 dsh 的 webServer 服务就绪后（端口已定）再启动反代。 */
const inject = ["webServer"];

// 配置项（普通函数插件不强制 schemastery 校验，apply 内用 ?? 默认值兜底）：
//   enabled      监听局域网访问总开关（默认 false；页面运行时开关优先级更高）
//   port         反代监听端口（所有网卡），默认 3080
//   statusPath   JSON API 路径前缀，默认 /__lan-proxy（嵌入 tab 的数据面）
//   maxLogLines  页面保留的日志行数，默认 500
//   upstreamPort 上游端口，默认 0 = 自动取 ctx.webServer.port（dsh 实际监听端口）

const UPSTREAM_HOST = "127.0.0.1";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ── 日志环形缓冲 ────────────────────────────────────────────────────────────

class LogRing {
  constructor(max) {
    this.max = max;
    this.lines = [];
  }
  add(level, msg) {
    this.lines.push({ ts: Date.now(), level, msg });
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
    return this.lines[this.lines.length - 1];
  }
  since(afterTs) {
    return this.lines.filter((l) => l.ts > afterTs);
  }
}

// ── 运行时配置（页面热切换，优先于配置里的 enabled/port/upstreamPort）──────

function profileDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "profiles", "web");
}

function runtimeFile() {
  return path.join(profileDir(), "lan-proxy.runtime.json");
}

function readRuntime() {
  try {
    return JSON.parse(readFileSync(runtimeFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeRuntime(patch) {
  const file = runtimeFile();
  const tmp = `${file}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...readRuntime(), ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  renameSync(tmp, file);
  return next;
}

/** 校验端口值：1-65535 整数；upstream 允许 0 = 自动。非法返回 null。 */
function normalizePort(v, allowZero) {
  if (typeof v === "string" && v.trim() !== "") v = Number(v);
  if (!Number.isInteger(v)) return null;
  if (allowZero && v === 0) return 0;
  return v >= 1 && v <= 65535 ? v : null;
}

// ── 局域网地址 ──────────────────────────────────────────────────────────────

function lanAddrs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === "IPv4" && !it.internal) out.push(it.address);
    }
  }
  return [...new Set(out)];
}

// ── 上游探测（带缓存）───────────────────────────────────────────────────────

let probeCache = { port: 0, at: 0, promise: null };
function getProbe(port) {
  const now = Date.now();
  if (probeCache.port !== port || !probeCache.promise || now - probeCache.at > 4000) {
    probeCache = { port, at: now, promise: probeUpstream(port) };
    probeCache.promise.catch(() => {});
  }
  return probeCache.promise;
}

function probeUpstream(port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get(
      { host: UPSTREAM_HOST, port, path: "/", timeout: 1500, headers: { host: `${UPSTREAM_HOST}:${port}` } },
      (res) => {
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode, ms: Date.now() - started });
        res.resume();
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, ms: Date.now() - started, error: "timeout" });
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, ms: Date.now() - started, error: e.message }));
  });
}

// ── 上游 Host/Origin 改写与 polyfill 注入 ──────────────────────────────────

function rewrite(headers, port) {
  headers.host = `${UPSTREAM_HOST}:${port}`;
  if (headers.origin !== undefined) headers.origin = `http://${UPSTREAM_HOST}:${port}`;
  return headers;
}

// ── 前端字节流 bypass 规则（屏蔽 dsh 对非回环来源的设置页封锁）───────────────
//
// dsh 的浏览器端只在 `window.location` 为回环地址时才会发起 settings RPC
// （connection.isLoopback → SettingsDescribeMirror persistence），局域网访问时
// 设置/模型/凭据页直接报 "settings are unavailable in this browser"。反代在
// 转发 `/plugins/<id>/client.js` 字节流时按规则表改写，把封锁判定从"看地址栏"
// 改成"恒为回环"。服务端 /api 信任栅栏按 Host 头判定，反代已把 Host 改回
// 127.0.0.1，所以服务端天然放行，无需动服务端。
//
// 规则是顺带改字节的前端补丁——官方每次换一种封锁方式，往表里加一条
// find/replace 即可（旧规则 find 不中自然跳过），不用改反代逻辑。
//
// id       规则唯一标识（日志面板展示用）
// path     目标 client bundle 的 URL 前缀（/plugins/<bundle id>/client.js）
// expect   find 锚定串（要能被新版本 grep 到才生效；写清楚意图）
// find     需要被替换的字节串（逐字匹配）
// replace  替换后的字节串
// enabled  置 false 可临时停用某条规则
const DEFAULT_BYPASS_RULES = [
  {
    id: "dsh-client-connection:isLoopback-mirror",
    path: "/plugins/@deepseek-ai/dsh-client-connection/client.js",
    expect: "isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname)",
    find: "isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),",
    replace: "isLoopback: true,",
    enabled: true,
  },
];

function normalizeBypassRule(rule) {
  return {
    id: rule.id,
    path: rule.path,
    expect: rule.expect ?? rule.find,
    find: rule.find,
    replace: rule.replace,
    enabled: rule.enabled !== false,
    hits: 0,
    lastError: null,
  };
}

/** 把一条规则应用到 JS 字节上；返回 null 表示未命中（本次不适用）。 */
function applyBypassRule(buf, rule) {
  if (!rule.enabled) return null;
  const text = buf.toString("utf8");
  if (!text.includes(rule.find)) {
    rule.lastError = "find 串未命中（官方可能已改动该处 JS）";
    return null;
  }
  const next = text.replace(rule.find, rule.replace);
  rule.hits += 1;
  rule.lastError = null;
  return Buffer.from(next, "utf8");
}

/** 一条路径命中的所有启用规则依次应用；返回改写后的字节，无命中返回原 buf。 */
function applyBypassRules(buf, pathname, rules, log) {
  let out = buf;
  for (const rule of rules) {
    if (!pathname.startsWith(rule.path)) continue;
    const patched = applyBypassRule(out, rule);
    if (patched !== null) {
      out = patched;
      log?.add("info", `[bypass] ${rule.id} 命中（累计 ${rule.hits} 次）`);
    } else {
      log?.add("warn", `[bypass] ${rule.id} 未命中：${rule.lastError}`);
    }
  }
  return out;
}

const POLYFILL_SCRIPT =
  "<script>if(window.crypto&&!window.crypto.randomUUID){window.crypto.randomUUID=function(){var b=new Uint8Array(16);window.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h=\"\";for(var i=0;i<16;i++){h+=b[i].toString(16).padStart(2,\"0\");}return h.slice(0,8)+\"-\"+h.slice(8,12)+\"-\"+h.slice(12,16)+\"-\"+h.slice(16,20)+\"-\"+h.slice(20);};}</script>";

function injectPolyfill(html) {
  const m = /<head[^>]*>/i.exec(html);
  const at = m ? m.index + m[0].length : 0;
  return html.slice(0, at) + POLYFILL_SCRIPT + html.slice(at);
}

// ── RFC6455 帧编解码（无扩展、无分片）───────────────────────────────────────

class FrameReader {
  constructor(socket, onFrame) {
    this.socket = socket;
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => this.push(chunk));
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      const fin = (b0 & 0x80) !== 0;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + len) return;
      let payload = Buffer.from(this.buffer.subarray(offset, offset + len));
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buffer = this.buffer.subarray(offset + len);
      if (!fin) continue;
      this.onFrame(opcode, payload);
    }
  }
}

function buildFrame(opcode, payload, masked) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len | (masked ? 0x80 : 0);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126 | (masked ? 0x80 : 0);
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127 | (masked ? 0x80 : 0);
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!masked) return Buffer.concat([header, payload]);
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, body]);
}

// ── WebSocket 桥 ────────────────────────────────────────────────────────────

class WsBridge {
  constructor(clientSocket, request, store) {
    this.socket = clientSocket;
    this.closed = false;
    this.upstream = null;
    this.upstreamReady = false;
    this.pending = [];
    this.store = store;
    this.clientReader = new FrameReader(clientSocket, (opcode, payload) => this.fromBrowser(opcode, payload));
    clientSocket.on("error", (e) => {
      this.log("warn", `[client-error] ${e.message}`);
      this.close("client-error");
    });
    clientSocket.on("close", () => this.close("client-close"));
    this.answerHandshake(request);
  }

  log(level, msg) {
    this.store.log.add(level, msg);
  }

  answerHandshake(request) {
    const key = request.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    const proto = request.headers["sec-websocket-protocol"];
    const protoHeader = proto ? `Sec-WebSocket-Protocol: ${proto}\r\n` : "";
    this.socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${protoHeader}\r\n`
    );
    this.connectUpstream(request.url, request.headers);
  }

  connectUpstream(path, browserHeaders) {
    const hdrs = { ...browserHeaders };
    hdrs.host = `${UPSTREAM_HOST}:${this.store.upstreamPort}`;
    if (hdrs.origin !== undefined) hdrs.origin = `http://${UPSTREAM_HOST}:${this.store.upstreamPort}`;
    delete hdrs["sec-websocket-extensions"];
    if (!hdrs["sec-websocket-key"]) hdrs["sec-websocket-key"] = randomBytes(16).toString("base64");
    const lines = [`GET ${path} HTTP/1.1`];
    for (const [k, v] of Object.entries(hdrs)) {
      if (v === undefined) continue;
      lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
    }
    const handshake = lines.join("\r\n") + "\r\n\r\n";
    const upstream = net.connect(this.store.upstreamPort, UPSTREAM_HOST);
    this.upstream = upstream;
    let response = Buffer.alloc(0);
    const onData = (chunk) => {
      response = Buffer.concat([response, chunk]);
      const idx = response.indexOf("\r\n\r\n");
      if (idx === -1) return;
      upstream.off("data", onData);
      const headText = response.toString("latin1", 0, idx);
      if (!headText.includes("101")) {
        this.log("warn", `[up-reject] 上游未回 101（${headText.split("\r\n")[0]}）`);
        this.close("upstream-not-101");
        return;
      }
      this.upstreamReader = new FrameReader(upstream, (opcode, payload) => this.fromUpstream(opcode, payload));
      this.upstreamReady = true;
      for (const [opcode, payload] of this.pending) {
        upstream.write(buildFrame(opcode, payload, true));
      }
      this.pending = [];
      const rest = response.subarray(idx + 4);
      if (rest.length > 0) this.upstreamReader.push(rest);
    };
    upstream.on("data", onData);
    upstream.on("connect", () => upstream.write(handshake));
    upstream.on("error", (e) => {
      this.log("warn", `[up-error] ${e.message}`);
      this.close("up-error");
    });
    upstream.on("close", () => this.close("up-close"));
  }

  fromUpstream(opcode, payload) {
    if (this.closed) return;
    this.socket.write(buildFrame(opcode, payload, false));
  }

  fromBrowser(opcode, payload) {
    if (this.closed) return;
    if (opcode === 0x8) {
      this.socket.write(buildFrame(0x8, payload.subarray(0, 2), false));
      if (this.upstream && !this.upstream.destroyed) {
        this.upstream.write(buildFrame(0x8, Buffer.from([0x03, 0xe8]), true));
      }
      this.close();
      return;
    }
    if (opcode === 0x9) {
      this.socket.write(buildFrame(0xa, payload, false));
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (this.upstreamReady && this.upstream && !this.upstream.destroyed) {
        this.upstream.write(buildFrame(opcode, payload, true));
      } else {
        this.pending.push([opcode, payload]);
      }
    }
  }

  close(reason = "unknown") {
    if (this.closed) return;
    this.log("info", `[bridge-close] ${reason}`);
    this.closed = true;
    try {
      this.store.lanProxy?.closeBridge?.(this);
    } catch {}
    this.socket.destroy();
    this.upstream?.destroy();
  }
}

// ── 内嵌反代服务 ────────────────────────────────────────────────────────────

class LanProxy {
  constructor(store) {
    this.store = store;
    this.server = null;
    this.bridges = new Set();
    this.statusPath = store.statusPath;
    this._closing = null;
    this._starting = false;
  }

  get running() {
    return this.server !== null && this.server.listening;
  }

  async start() {
    if (this.running || this._starting) return;
    if (this._closing) {
      try {
        await this._closing;
      } catch {}
    }
    if (this.running) return;
    const store = this.store;
    this._starting = true;
    try {
      store.state = "starting";
      store.error = null;
      const server = http.createServer((req, res) => this.onRequest(req, res));
      this.server = server;
      server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
      server.on("error", (err) => {
        store.state = "error";
        store.error = err.message;
        store.log.add("error", `[listen-error] ${err.message}`);
        if (this.server === server) this.server = null;
      });
      await new Promise((resolve) => {
        server.once("listening", resolve);
        server.once("error", resolve);
        server.listen(store.listenPort, "0.0.0.0");
      });
      if (store.error) return;
      store.state = "listening";
      store.startedAt = Date.now();
      store.log.add("info", `已监听 0.0.0.0:${store.listenPort} → ${UPSTREAM_HOST}:${store.upstreamPort}`);
    } finally {
      this._starting = false;
    }
  }

  stop() {
    const store = this.store;
    const server = this.server;
    this.server = null;
    for (const bridge of [...this.bridges]) {
      try {
        bridge.close("proxy-stop");
      } catch {}
    }
    if (server) {
      try {
        server.closeAllConnections();
      } catch {}
      this._closing = new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
      this._closing.finally(() => {
        if (this._closing) this._closing = null;
      });
      server.removeAllListeners("error");
    }
    if (store.state === "listening" || store.state === "starting") {
      store.state = "stopped";
      store.log.add("info", "反代已停止");
    }
    return this._closing ?? Promise.resolve();
  }

  onRequest(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url ?? "/", "http://x").pathname;
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad request");
      return;
    }
    if (this.isStatusPath(pathname)) {
      handleStatusPath(req, res, pathname, this.store, "lan");
      return;
    }
    this.proxyHttp(req, res);
  }

  isStatusPath(pathname) {
    // 只拦截 JSON API 前缀（嵌入 tab 的数据面）；其余路径透传给上游 dsh
    // 前端，本机与局域网行为一致（不再有独立状态页）。
    const p = this.statusPath.replace(/\/+$/, "");
    return pathname.startsWith(`${p}${STATUS_JSON_PATH}`) ||
      pathname.startsWith(`${p}${LOGS_JSON_PATH}`) ||
      pathname.startsWith(`${p}${TOGGLE_PATH}`) ||
      pathname.startsWith(`${p}${RESTART_PATH}`) ||
      pathname.startsWith(`${p}${CONFIG_PATH}`);
  }

  proxyHttp(req, res) {
    const store = this.store;
    const headers = rewrite({ ...req.headers }, store.upstreamPort);
    delete headers["accept-encoding"];
    const proxy = http.request({
      host: UPSTREAM_HOST,
      port: store.upstreamPort,
      method: req.method,
      path: req.url,
      headers,
    });
    proxy.on("response", (upstream) => {
      // dsh web 浏览器鉴权:局域网首次访问 index(GET /)未带 cookie 时上游回 401。
      // 反代自动用 launchToken 走一次 /?token= 交换,把 303 + Set-Cookie 转给浏览器,
      // 浏览器随后带 cookie 访问即通过——局域网用户无感(等价本地 localhost)。
      // 限 5s 窗口防异常场景下 303 死循环;带 token 的请求本身不触发。
      const pathname = this.pathname(req.url);
      if (
        upstream.statusCode === 401 &&
        req.method === "GET" &&
        pathname === "/" &&
        store.launchToken &&
        !req.url.includes("token=") &&
        Date.now() - (store.lastAutoAuthAt || 0) > 5000
      ) {
        upstream.resume();
        this.autoAuthenticate(req, res);
        return;
      }
      const type = upstream.headers["content-type"] || "";
      // HTML 注入 polyfill；JS 应用 bypass 规则（屏蔽非回环设置封锁）。
      // 两者都需要收完整个响应体重算 content-length，所以并成一个改造分支。
      const needsRewrite = /text\/html/i.test(type) || store.bypassRules.some((r) => r.enabled && pathname.startsWith(r.path));
      if (req.method !== "HEAD" && needsRewrite) {
        const chunks = [];
        upstream.on("data", (c) => chunks.push(c));
        upstream.on("end", () => {
          let out = Buffer.concat(chunks);
          if (/text\/html/i.test(type)) out = Buffer.from(injectPolyfill(out.toString("utf8")), "utf8");
          else out = applyBypassRules(out, pathname, store.bypassRules, store.log);
          const h = { ...upstream.headers };
          delete h["content-length"];
          delete h["transfer-encoding"];
          delete h["content-encoding"];
          h["content-length"] = out.length;
          res.writeHead(upstream.statusCode, h);
          res.end(out);
        });
        upstream.on("error", () => {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end("proxy error: upstream aborted");
        });
        return;
      }
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
    });
    proxy.on("error", (err) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`proxy error: ${err.message}`);
    });
    req.pipe(proxy);
  }

  /** 内部完成 dsh 浏览器鉴权的 token 交换，把 303 + Set-Cookie 转给浏览器。 */
  autoAuthenticate(req, res) {
    const store = this.store;
    store.lastAutoAuthAt = Date.now();
    const exchange = http.request({
      host: UPSTREAM_HOST,
      port: store.upstreamPort,
      method: "GET",
      path: `/?token=${encodeURIComponent(store.launchToken)}`,
      headers: rewrite({ host: `${UPSTREAM_HOST}:${store.upstreamPort}`, accept: "text/html" }, store.upstreamPort),
    });
    exchange.on("response", (up) => {
      const setCookie = up.headers["set-cookie"];
      up.resume();
      const ok = up.statusCode >= 300 && up.statusCode < 400 && setCookie;
      store.log.add(ok ? "info" : "warn", `[auth] 自动 token 交换 → 上游 ${up.statusCode}${ok ? "，已发放 cookie" : "，未发放 cookie（透传 401）"}`);
      if (ok) {
        res.writeHead(303, {
          "location": "/",
          "referrer-policy": "no-referrer",
          "cache-control": "no-store",
          "set-cookie": setCookie,
        });
        res.end();
      } else {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end("dsh web authentication required; reopen the URL printed by dsh web.\n");
      }
    });
    exchange.on("error", (err) => {
      store.log.add("warn", `[auth] 自动 token 交换失败: ${err.message}`);
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`proxy error: ${err.message}`);
    });
    exchange.end();
  }

  pathname(url) {
    try {
      return new URL(url ?? "/", "http://x").pathname;
    } catch {
      return "/";
    }
  }

  onUpgrade(req, socket, head) {
    const store = this.store;
    store.upgrades += 1;
    store.log.add("info", `[upgrade] ${req.url} from ${req.socket.remoteAddress}`);
    try {
      const bridge = new WsBridge(socket, req, store);
      this.bridges.add(bridge);
      if (head && head.length) bridge.clientReader.push(head);
    } catch (e) {
      store.log.add("warn", `[bridge-err] ${e.message}`);
      socket.destroy();
    }
  }

  closeBridge(bridge) {
    this.bridges.delete(bridge);
  }
}

// ── 状态/日志页（反代与 dsh webServer 路由共用）────────────────────────────

const STATUS_JSON_PATH = "/api/status";
const LOGS_JSON_PATH = "/api/logs";
const TOGGLE_PATH = "/api/set-enabled";
const RESTART_PATH = "/api/restart";
const CONFIG_PATH = "/api/set-config";

function isLoopback(req) {
  const a = req.socket?.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function writeJson(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function statusPayload(store) {
  return {
    enabled: store.effectiveEnabled,
    configEnabled: store.configEnabled,
    runtimeFile: store.runtimeFileExists,
    state: store.state,
    error: store.error,
    listenHost: "0.0.0.0",
    listenPort: store.listenPort,
    upstream: `${UPSTREAM_HOST}:${store.upstreamPort}`,
    upstreamPort: store.upstreamPort,
    autoUpstreamPort: store.autoUpstreamPort,
    startedAt: store.startedAt,
    uptimeMs: store.startedAt ? Date.now() - store.startedAt : 0,
    upgrades: store.upgrades,
    lanAddrs: lanAddrs(),
    auth: store.launchToken ? "auto" : "unavailable",
    bypass: store.bypassRules.map((r) => ({ id: r.id, enabled: r.enabled, hits: r.hits, lastError: r.lastError })),
  };
}

async function handleStatusPath(req, res, pathname, store, via) {
  const base = store.statusPath.replace(/\/+$/, "");
  if (pathname === `${base}${STATUS_JSON_PATH}`) {
    const probe = await getProbe(store.upstreamPort).catch(() => ({ ok: false, status: 0, error: "probe failed" }));
    writeJson(res, 200, { ...statusPayload(store), probe });
    return;
  }
  if (pathname === `${base}${LOGS_JSON_PATH}`) {
    const since = Number(new URL(req.url, "http://x").searchParams.get("since") || 0);
    writeJson(res, 200, { lines: store.log.since(since) });
    return;
  }
  if (pathname === `${base}${TOGGLE_PATH}`) {
    if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: "仅限本机操作" });
    let body = "";
    for await (const c of req) body += c;
    let want;
    try {
      want = JSON.parse(body).enabled;
    } catch {
      return writeJson(res, 400, { ok: false, error: "bad body" });
    }
    store.applyToggle(Boolean(want));
    writeJson(res, 200, { ok: true, enabled: store.effectiveEnabled });
    return;
  }
  if (pathname === `${base}${CONFIG_PATH}`) {
    if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: "仅限本机操作" });
    let body = "";
    for await (const c of req) body += c;
    let cfg;
    try {
      cfg = JSON.parse(body);
    } catch {
      return writeJson(res, 400, { ok: false, error: "bad body" });
    }
    const listen = normalizePort(cfg.listenPort, false);
    const upstream = normalizePort(cfg.upstreamPort, true);
    if (listen === null || upstream === null) {
      return writeJson(res, 400, { ok: false, error: "端口需为 1-65535 的整数" });
    }
    store.applyConfig({ listenPort: listen, upstreamPort: upstream });
    writeJson(res, 200, { ok: true, listenPort: store.listenPort, upstreamPort: store.upstreamPort });
    return;
  }
  if (pathname === `${base}${RESTART_PATH}`) {
    if (!isLoopback(req)) return writeJson(res, 403, { ok: false, error: "仅限本机操作" });
    store.restart();
    writeJson(res, 200, { ok: true, state: store.state });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

// ── Cordis 插件 ─────────────────────────────────────────────────────────────

function apply(ctx, config = {}) {
  const configListenPort = config.port ?? 3080;
  const statusPath = ("/" + (config.statusPath ?? "/__lan-proxy").replace(/^\/+|\/+$/g, "")).replace(/\/+$/, "") || "/__lan-proxy";
  const maxLogLines = config.maxLogLines ?? 500;

  const configEnabled = config.enabled ?? false;
  const runtime = readRuntime();
  const runtimeEnabled = typeof runtime.enabled === "boolean" ? runtime.enabled : undefined;
  const effectiveEnabled = runtimeEnabled !== undefined ? runtimeEnabled : configEnabled;

  // 端口：运行时 > 配置 > 默认。upstream 为 0 表示自动取 dsh 实际端口。
  const configUpstreamPort = config.upstreamPort ?? 0;
  const rawListen = runtime.listenPort !== undefined ? runtime.listenPort : configListenPort;
  const rawUpstream = runtime.upstreamPort !== undefined ? runtime.upstreamPort : configUpstreamPort;
  const listenPort = normalizePort(rawListen, false) ?? configListenPort;
  const upstreamSetting = normalizePort(rawUpstream) ?? 0;
  const autoUpstreamPort = ctx.webServer?.port || listenPort;
  const upstreamPort = upstreamSetting || autoUpstreamPort;

  const enabledRulesInput = Array.isArray(config.bypassRules) ? config.bypassRules : DEFAULT_BYPASS_RULES;
  const bypassRules = enabledRulesInput.map(normalizeBypassRule);

  const store = {
    listenPort,
    upstreamPort,
    autoUpstreamPort,
    statusPath,
    bypassRules,
    configEnabled,
    effectiveEnabled,
    runtimeFileExists: runtime.enabled !== undefined || runtime.listenPort !== undefined || runtime.upstreamPort !== undefined,
    state: "stopped",
    error: null,
    startedAt: 0,
    upgrades: 0,
    log: new LogRing(maxLogLines),
    lanProxy: null,
    applyToggle(want) {
      this.effectiveEnabled = want;
      this.runtimeFileExists = true;
      writeRuntime({ enabled: want });
      ctx.logger.info(`lan-proxy: 页面开关 → ${want ? "开" : "关"}`);
      this.log.add("info", `页面开关 → ${want ? "开" : "关"}（已写入 ${runtimeFile()}）`);
      if (want) this.lanProxy.start().catch(() => {});
      else this.lanProxy.stop().catch(() => {});
    },
    applyConfig({ listenPort: lp, upstreamPort: up }) {
      this.listenPort = lp;
      this.upstreamPort = up || this.autoUpstreamPort;
      this.runtimeFileExists = true;
      writeRuntime({ listenPort: lp, upstreamPort: up });
      ctx.logger.info(`lan-proxy: 端口配置 → 监听 ${lp}, 上游 ${up || "自动(" + this.autoUpstreamPort + ")"}`);
      this.log.add("info", `端口配置 → 监听 0.0.0.0:${lp}，上游 ${up ? UPSTREAM_HOST + ":" + up : "自动" + UPSTREAM_HOST + ":" + this.autoUpstreamPort}`);
      this.restart();
    },
    restart() {
      ctx.logger.info("lan-proxy: 手动重启反代");
      this.log.add("info", "手动重启反代");
      this.lanProxy
        .stop()
        .catch(() => {})
        .then(() => this.lanProxy.start().catch(() => {}));
    },
  };

  store.log.add("info", `插件 v${PLUGIN_VERSION} 加载，配置 enabled=${configEnabled}，运行时=${runtimeEnabled ?? "未设置"}，生效=${effectiveEnabled}，端口 监听=${listenPort} 上游=${upstreamSetting ? upstreamPort : "自动(" + autoUpstreamPort + ")"}`);
  ctx.logger.info(`dsh-plugin-lan-proxy: enabled=${configEnabled} runtime=${runtimeEnabled ?? "未设置"} effective=${effectiveEnabled} listen=0.0.0.0:${listenPort} upstream=${UPSTREAM_HOST}:${upstreamPort} statusPath=${statusPath}`);
  if (!effectiveEnabled) {
    store.state = "stopped";
    ctx.logger.info("dsh-plugin-lan-proxy: 未启用，反代未启动（开关/状态仍可通过设置页操作）");
  }

  const lanProxy = new LanProxy(store);
  store.lanProxy = lanProxy;
  if (effectiveEnabled) lanProxy.start().catch(() => {});

  // dsh web 浏览器鉴权:index 路径首次访问需 ?token=<launchToken> 交换 cookie。
  // 通过官方 connection 服务的 authenticatedUrl() 动态取 token(每次启动都会变),
  // 让反代在局域网访问时自动完成交换,用户无感,无需随版本频繁适配。
  ctx.inject(["connection"], (connectionCtx) => {
    try {
      const authUrl = new URL(connectionCtx.connection.authenticatedUrl(`http://${UPSTREAM_HOST}:${store.upstreamPort}`));
      const token = authUrl.searchParams.get("token") || "";
      if (token) {
        store.launchToken = token;
        ctx.logger.info("dsh-plugin-lan-proxy: 已接入 dsh 浏览器鉴权,局域网访问自动完成授权");
        store.log.add("info", "已接入 dsh 浏览器鉴权（局域网访问自动完成 token 交换）");
      } else {
        store.log.add("warn", "connection.authenticatedUrl() 未返回 token,局域网访问将需手动授权");
      }
    } catch (e) {
      ctx.logger.warn(`dsh-plugin-lan-proxy: 获取 launchToken 失败: ${e.message}`);
      store.log.add("warn", `获取 launchToken 失败: ${e.message}`);
    }
  });

  // 本机直达（127.0.0.1）由 dsh 的 webServer 路由提供 JSON API
  const base = statusPath;
  const disposers = [];
  for (const p of [`${base}${STATUS_JSON_PATH}`, `${base}${LOGS_JSON_PATH}`, `${base}${TOGGLE_PATH}`, `${base}${RESTART_PATH}`, `${base}${CONFIG_PATH}`]) {
    try {
      disposers.push(ctx.webServer.register({ kind: "exact", path: p, handler: (req, res) => handleStatusPath(req, res, p, store, "loopback") }));
    } catch (e) {
      ctx.logger.warn(`dsh-plugin-lan-proxy: 注册本机路由 ${p} 失败：${e.message}`);
    }
  }

  ctx.effect(() => async () => {
    for (const d of disposers) {
      try {
        d();
      } catch {}
    }
    lanProxy.stop();
  });
}

const PLUGIN_VERSION = "0.4.0";

export { apply, inject, name };