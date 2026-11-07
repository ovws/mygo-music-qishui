// MyGo Qishui: official browser SDK authentication runs in a private helper.
// No unsigned-fetch fallback, no default/placeholder successful account.
const VERSION = "0.4.5";
const cookie = () => host.storage.get("authBackend") === "sdk-v1" ? host.storage.get("cookie") || "" : "";
function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function needAccount() { if (!account()) throw fail("signIn", "请先使用官方 SDK 登录汽水音乐。"); }

// ---------- Private JSONL helper ----------
let helper = null, starting = null, signingIn = false;
const STAGES = new Set(["starting", "waiting-scan", "scanned", "verification", "verifying-account", "authenticated", "failed"]);
const ERROR_MESSAGES = {
  input: '汽水功能参数无效。',
  limit: '汽水数据超过处理上限。',
  pagination: '汽水分页数据不完整或超过读取上限。',
  'mutation-unknown': '操作可能已完成，结果未知。请先核对当前状态，不要自动重试。',
  cache: '操作已完成，但缓存未能刷新。请核对当前状态，不要重复提交。',
  setup: '汽水 SDK 运行时未就绪。请在插件目录运行 node helper/install.cjs；依赖将安装到独立数据目录。不要在插件目录执行 npm install/ci。',
  protocol: '汽水辅助程序协议数据无效。',
  busy: '已有汽水登录正在进行，请先完成或取消当前登录。',
  network: '无法连接汽水认证服务，请检查网络。',
  timeout: '汽水操作超时。',
  cancelled: '汽水登录或安全验证已取消。',
  sdk: '官方安全 SDK 未就绪或没有生成安全参数，已停止登录。',
  integrity: '官方 SDK 文件摘要校验失败，未执行该文件。',
  response: '汽水返回了无法识别的响应。',
  session: '汽水尚未向本插件下发有效登录会话。',
  account: '取得会话后仍无法验证汽水账号，本次未判定为登录成功。',
  api: '汽水接口拒绝请求。',
  verification: '汽水要求的官方安全验证未完成。',
  unavailable: '当前环境无法运行汽水官方 SDK。',
  audio: '这首歌的音频格式或授权数据暂不支持，未尝试绕过播放限制。',
  entitlement: '当前账号没有这首歌所返回音质的可验证播放权限。',
  preview: '服务端只提供了试听片段，当前插件不会将其作为完整版播放。',
  ffmpeg: '音频处理失败。请确认 ffmpeg 支持 AAC、libmp3lame 和 FLAC 解码。',
};
const ERROR_CODES = new Set(Object.keys(ERROR_MESSAGES));
function diagnostic(stage, error) {
  const info = { version: VERSION, backend: "official-sdk", stage, at: new Date().toISOString() };
  if (Number.isInteger(error?.apiCode)) info.errorCode = error.apiCode;
  if (Number.isInteger(error?.httpStatus)) info.httpStatus = error.httpStatus;
  host.storage.set("loginDiagnostic", info);
  console.log("[qishui] login:", JSON.stringify(info));
}
function helperError(value) {
  const code = ERROR_CODES.has(value?.code) ? value.code : "protocol";
  const setup = ["setup", "integrity", "unavailable", "ffmpeg"].includes(code);
  let message = ERROR_MESSAGES[code];
  if (Number.isInteger(value?.apiCode)) message += `（错误码 ${value.apiCode}）`;
  const confirmed = ["mutation-unknown", "api", "cache"].includes(code) && Number.isSafeInteger(value?.confirmed) && value.confirmed >= 0 && value.confirmed <= 100;
  if (confirmed) message += `（已确认 ${value.confirmed} 项）`;
  const error = fail(setup ? "setup" : "qishui-" + code, message);
  if (Number.isInteger(value?.apiCode)) error.apiCode = value.apiCode;
  if (Number.isInteger(value?.httpStatus)) error.httpStatus = value.httpStatus;
  if (["metadata", "entitlement", "download", "decrypt", "encode", "verify"].includes(value?.stage)) error.stage = value.stage;
  if (confirmed) error.confirmed = value.confirmed;
  return error;
}
function stopHelper(client, error) {
  if (client.closed) return;
  client.closed = true;
  if (helper === client) helper = null;
  for (const entry of client.pending.values()) { clearTimeout(entry.timer); entry.reject(entry.mutation ? helperError({code:"mutation-unknown"}) : error); }
  client.pending.clear();
  try { client.process.kill(); } catch {}
}
async function pump(client) {
  try {
    for (;;) {
      const line = await client.process.readLine(); if (line === null) break;
      if (line.length > 4 * 1024 * 1024) throw helperError({ code: "protocol" });
      let packet;
      try { packet = JSON.parse(line); } catch { throw helperError({ code: "protocol" }); }
      if (packet.event === "fatal") throw helperError(packet.error);
      const entry = client.pending.get(packet.id); if (!entry) continue;
      if (packet.event === "prompt") {
        if (entry.onPrompt) entry.onPrompt(packet);
        continue;
      }
      if (typeof packet.ok !== "boolean") throw helperError({ code: "protocol" });
      clearTimeout(entry.timer); client.pending.delete(packet.id);
      if (packet.ok) entry.resolve(packet.result); else entry.reject(helperError(packet.error));
    }
    stopHelper(client, fail("qishui-helper", "汽水 SDK 辅助程序已退出，登录未完成。"));
  } catch (error) { stopHelper(client, error); }
}
function send(client, op, params = {}, timeout = 40000, onPrompt) {
  return new Promise((resolve, reject) => {
    if (client.closed) { reject(fail("qishui-helper", "汽水 SDK 辅助程序已停止。")); return; }
    const id = ++client.nextId;
    const timer = setTimeout(() => stopHelper(client, fail("qishui-timeout", "汽水 SDK 辅助程序等待超时，已停止本次操作。")), timeout);
    client.pending.set(id, { resolve, reject, timer, onPrompt, mutation: op === "catalog" && ["postComment","like","savePlaylist","saveAlbum","createPlaylist","renamePlaylist","deletePlaylist","addToPlaylist","removeFromPlaylist","played"].includes(params.method) });
    try { client.process.write(JSON.stringify({ id, op, params }) + "\n"); }
    catch { stopHelper(client, fail("qishui-helper", "无法向汽水 SDK 辅助程序发送请求。")); }
  });
}
async function ensureHelper() {
  if (helper && !helper.closed) return helper;
  if (starting) return starting;
  starting = (async () => {
    let process;
    for (const node of ["node", "/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
      try { process = host.spawn(node, [host.dir + "/helper/launch.cjs", "--data-dir", host.dataDir + "/auth-sdk"]); break; } catch {}
    }
    if (!process) throw fail("setup", "汽水 SDK 登录需要 Node.js，以及插件设置中的启动程序权限。请先按 README 安装 helper 依赖并允许启动 Node。");
    const client = { process, pending: new Map(), nextId: 0, closed: false };
    helper = client; pump(client);
    const hello = await send(client, "hello", {}, 8000);
    if (hello?.protocol !== 1 || typeof hello.version !== "string") {
      const error = fail("setup", "汽水辅助程序版本不兼容，请重新安装 helper 依赖。"); stopHelper(client, error); throw error;
    }
    return client;
  })();
  try { return await starting; } finally { starting = null; }
}
function hasSession(value) {
  return typeof value === "string" && value.split(";").some((part) => {
    const at = part.indexOf("=");
    return at > 0 && ["sessionid", "sessionid_ss", "sid_guard", "sid_tt"].includes(part.slice(0, at).trim()) &&
      !["", "deleted", "null", "undefined"].includes(part.slice(at + 1).trim().toLowerCase());
  });
}
function verifiedResult(result) {
  return hasSession(result?.cookie) && typeof result?.account?.id === "string" && Boolean(result.account.id) &&
    typeof result?.account?.name === "string" && Boolean(result.account.name);
}
function progress(packet) {
  if (!STAGES.has(packet.stage) || typeof packet.text !== "string" || packet.text.length > 4000) throw helperError({ code: "protocol" });
  let qr;
  if (packet.qr !== undefined) {
    const url = new URL(packet.qr);
    if (url.origin !== "https://bff-pc.qishui.com" || !url.searchParams.get("token")) throw helperError({ code: "protocol" });
    qr = url.href;
  }
  diagnostic(packet.stage);
  host.signInPrompt({ ...(qr ? { qr } : {}), text: `[汽水 ${VERSION} SDK] ${packet.text}` });
}
export async function signIn() {
  if (signingIn) throw fail("qishui-busy", "已有登录正在进行，请先完成当前登录。");
  signingIn = true;
  try {
    diagnostic("starting");
    const client = await ensureHelper();
    const result = await send(client, "signIn", {}, 260000, progress);
    if (!verifiedResult(result)) throw fail("qishui-account", "辅助程序没有返回经过验证的登录会话和账号，未完成登录。");
    host.storage.set("account", result.account);
    host.storage.set("cookie", result.cookie);
    host.storage.set("authBackend", "sdk-v1");
    diagnostic("authenticated");
    return result.account;
  } catch (error) { diagnostic("failed", error); throw error; }
  finally { signingIn = false; }
}
export function account() {
  const me = host.storage.get("account");
  return cookie() && typeof me?.id === "string" && me.id && typeof me?.name === "string" && me.name ? me : null;
}
export async function signOut() {
  try { if (helper || cookie()) await send(await ensureHelper(), "signOut"); }
  finally { host.storage.remove("cookie"); host.storage.remove("account"); host.storage.remove("authBackend"); }
}
async function catalog(method, args = {}) {
  needAccount();
  return send(await ensureHelper(), "catalog", { method, args }, 28000);
}
export function home(args) { return catalog("home", args); }
export function browse(args) { return catalog("browse", args); }
export function search(args) { return catalog("search", args); }
export function playlists(args) { return catalog("playlists", args); }
export function playlist(args) { return catalog("playlist", args); }
export function liked(args) { return catalog("liked", args); }
export function isLiked(args) { return catalog("isLiked", args); }
export function savedAlbums(args) { return catalog("savedAlbums", args); }
export function recent(args) { return catalog("recent", args); }
export function stations(args) { return catalog("stations", args); }
export function stationNext(args) { return catalog("stationNext", args); }
export function lyrics(args) { return catalog("lyrics", args); }
export function comments(args) { return catalog("comments", args); }
export function postComment(args) { return catalog("postComment", args); }
export function like(args) { return catalog("like", args); }
export function savePlaylist(args) { return catalog("savePlaylist", args); }
export function saveAlbum(args) { return catalog("saveAlbum", args); }
export function createPlaylist(args) { return catalog("createPlaylist", args); }
export function renamePlaylist(args) { return catalog("renamePlaylist", args); }
export function deletePlaylist(args) { return catalog("deletePlaylist", args); }
export function played(args) { return catalog("played", args); }
export function addToPlaylist({id, trackIds}) {
  return catalog("addToPlaylist", {playlistId:id, ids:trackIds});
}
export function removeFromPlaylist({id, trackIds}) {
  return catalog("removeFromPlaylist", {playlistId:id, ids:trackIds});
}

// ---------- Playback: the helper resolves rights, decrypts authorized audio and prepares MP3/FLAC ----------
export async function stream({ id, quality = "standard" }) {
  needAccount();
  let result;
  try { result = await send(await ensureHelper(), "stream", { id, quality }, 28000); }
  catch (error) {
    host.storage.set("playbackDiagnostic", {
      version: VERSION, status: "failed", ...(error.stage ? { stage: error.stage } : {}),
      ...(Number.isInteger(error.apiCode) ? { errorCode: error.apiCode } : {}),
    });
    throw error;
  }
  let url;
  try { url = new URL(result?.url); } catch { throw fail("unavailable", "汽水辅助程序没有返回有效音频。"); }
  const normExpected = host.dataDir.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() + "/auth-sdk/audio-cache/";
  let normFile = decodeURIComponent(url.pathname).replace(/^\/([a-zA-Z]:)/, "$1").toLowerCase();
  const relPath = normFile.startsWith(normExpected) ? normFile.slice(normExpected.length) : "";
  if (url.protocol !== "file:" || url.hostname || url.search || url.hash || !relPath ||
      !/^run-[a-z0-9]+\/[a-f0-9]{32}\.(mp3|flac)$/i.test(relPath) ||
      !["mp3", "flac"].includes(result.type) || !normFile.endsWith("." + result.type) || !Number.isSafeInteger(result.size) || result.size <= 0) {
    throw fail("unavailable", "汽水辅助程序返回了无法验证的音频文件。");
  }
  host.storage.set("playbackDiagnostic", { version: VERSION, status: "prepared", size: result.size });
  return { url: url.href, type: result.type, size: result.size, quality: result.quality, bitRate: result.bitRate };
}
