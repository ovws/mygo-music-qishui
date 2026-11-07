'use strict';
const { BrowserWindow, session, protocol } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadRuntime } = require('./dependencies.cjs');
const { ensureAssets, ASSETS } = require('./assets.cjs');
const { fault, apiURL } = require('./protocol.cjs');
const { runLogin, hasSession } = require('./auth-flow.cjs');
const { Features, featureContext } = require('./features.cjs');
const { Playback } = require('./playback.cjs');
const API = 'https://api.qishui.com';
const APP_VERSION = '3.5.2';
const ORIGIN = 'app://resources';
const PAGE = ORIGIN + '/auth/index.html';
const BDMS_URL = ASSETS.find(a => a.name === 'bdms.js').url;
const UA = `Mozilla/5.0 (${process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0; Win64; x64'}) AppleWebKit/537.36 (KHTML, like Gecko) SodaMusic/${APP_VERSION} Chrome/136.0.7103.59 Electron/36.4.0-rs.22.release.main.1 Safari/537.36`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
function digits(length) { return String(crypto.randomInt(1, 9)) + Array.from({ length: length - 1 }, () => crypto.randomInt(10)).join(''); }
function parseJSON(text, status) {
  if (status < 200 || status >= 300) throw fault('network', { httpStatus: status });
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 3 * 1024 * 1024) throw fault('response');
  try { const parsed = JSON.parse(text); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw 0; return parsed; }
  catch { throw fault('response'); }
}
function checkPacket(packet) {
  const code = Number(packet.status_code ?? packet.error_code ?? packet.data?.error_code ?? 0);
  if (!Number.isFinite(code)) throw fault('response');
  if (code !== 0 || packet.message === 'error') throw fault('api', { apiCode: code });
  return packet;
}
function profileOf(packet) {
  checkPacket(packet);
  const data = packet.data || packet;
  const user = data.my_info || data.user || data.user_info || data.account || data.me || data;
  const id = user.user_id ?? user.uid ?? user.id ?? data.user_id ?? data.uid;
  if (!['string', 'number'].includes(typeof id) || !String(id) || String(id) === '0') throw fault('account');
  const name = user.nickname || user.nick_name || user.name || data.nickname || '汽水音乐用户';
  const image = user.avatar_url || user.medium_avatar_url || user.avatar?.url_list?.[0];
  return { id: String(id), name: String(name), ...(typeof image === 'string' && /^https:\/\//.test(image) ? { imageUrl: image } : {}) };
}
class Runtime {
  constructor(dataDir, emit) {
    this.dataDir = dataDir; this.emit = emit; this.window = null; this.initializing = null;
    this.msToken = ''; this.issuedToken = ''; this.observed = null; this.controller = null; this.signedRequests = new Map();
    this.sdkReady = false; this.native = null; this.nativeLoaded = false; this.locked = false;
    this.dependencies = loadRuntime(dataDir);
    this.features = new Features({ api: (...args) => this.api(...args), account: () => this.featureAccount() });
    this.qrcode = this.dependencies.require('qrcode');
    this.playback = new Playback({ dataDir, api: (...args) => this.api(...args) });
  }
  async base() {
    if (this.identity) return;
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dataDir, 0o700);
    const file = path.join(this.dataDir, 'identity.json');
    try {
      const raw = await fs.readFile(file, 'utf8'); if (raw.length > 4096) throw fault('setup');
      this.identity = JSON.parse(raw);
      if (!/^\d{15,19}$/.test(this.identity.deviceId) || !/^\d{15,19}$/.test(this.identity.installId) || typeof this.identity.portraitId !== 'string') throw fault('setup');
    } catch (error) {
      if (error.code !== 'ENOENT') throw fault('setup');
      this.identity = { deviceId: digits(16), installId: digits(15), portraitId: crypto.randomUUID() + '.login', computerName: 'MyGo Music' };
      await fs.writeFile(file, JSON.stringify(this.identity), { mode: 0o600, flag: 'wx' });
    }
    this.ses = session.fromPartition('persist:mygo-qishui-sdk');
    this.ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.ses.setPermissionCheckHandler(() => false);
    this.installHooks();
  }
  installHooks() {
    const preflight = new Map();
    this.ses.webRequest.onBeforeRequest({ urls: [BDMS_URL] }, (_details, callback) => callback({ redirectURL: ORIGIN + '/auth/bdms.js' }));
    const hosts = [API + '/*', 'https://api5-lq.qishui.com/*', 'https://verify.zijieapi.com/*', 'https://auth.zijieapi.com/*'];
    this.ses.webRequest.onBeforeSendHeaders({ urls: hosts }, (details, callback) => {
      if (details.method === 'OPTIONS') {
        for (const [key, value] of Object.entries(details.requestHeaders)) if (key.toLowerCase() === 'access-control-request-headers') preflight.set(details.id, value);
      } else {
        const url = new URL(details.url); const trace = url.searchParams.get('biz_trace_id');
        if (url.origin === API && trace) {
          this.signedRequests.set(trace, details.url);
          while (this.signedRequests.size > 32) this.signedRequests.delete(this.signedRequests.keys().next().value);
        }
      }
      callback({ requestHeaders: details.requestHeaders });
    });
    this.ses.webRequest.onHeadersReceived({ urls: hosts }, (details, callback) => {
      const headers = { ...details.responseHeaders };
      for (const [key, values] of Object.entries(headers)) {
        if (key.toLowerCase() === 'x-ms-token' && values[0]) this.issuedToken = values[0];
        if (key.toLowerCase().startsWith('access-control-')) delete headers[key];
      }
      // Scope CORS adaptation to this private renderer/session. Web security stays enabled.
      headers['Access-Control-Allow-Origin'] = [ORIGIN];
      headers['Access-Control-Allow-Credentials'] = ['true'];
      headers['Access-Control-Allow-Headers'] = [preflight.get(details.id) || 'content-type,x-ss-stub,x-tt-passport-csrf-token,x-tt-passport-trace-id,x-tt-passport-verify-portrait,x-tt-trace-id'];
      headers['Access-Control-Allow-Methods'] = ['GET,POST,OPTIONS'];
      headers['Access-Control-Expose-Headers'] = ['x-ms-token'];
      preflight.delete(details.id);
      callback({ responseHeaders: headers, ...(details.method === 'OPTIONS' ? { statusLine: 'HTTP/1.1 204 No Content' } : {}) });
    });
  }
  async ready() {
    if (this.sdkReady && this.window && !this.window.isDestroyed()) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.initialize().finally(() => { this.initializing = null; });
    return this.initializing;
  }
  async initialize() {
    await this.base();
    const assets = await ensureAssets(path.join(this.dataDir, 'assets'));
    const files = new Map([
      ['/auth/index.html', [path.join(__dirname, 'renderer.html'), 'text/html; charset=utf-8']],
      ['/auth/renderer.js', [path.join(__dirname, 'renderer.js'), 'text/javascript; charset=utf-8']],
      ['/auth/react.js', [path.join(path.dirname(this.dependencies.require.resolve('react/package.json')), 'umd/react.production.min.js'), 'text/javascript; charset=utf-8']],
      ['/auth/react-dom.js', [path.join(path.dirname(this.dependencies.require.resolve('react-dom/package.json')), 'umd/react-dom.production.min.js'), 'text/javascript; charset=utf-8']],
      ...[...assets].map(([name, file]) => ['/auth/' + name, [file, 'text/javascript; charset=utf-8']]),
    ]);
    if (await this.ses.protocol.isProtocolHandled('app')) this.ses.protocol.unhandle('app');
    this.ses.protocol.handle('app', async request => {
      const url = new URL(request.url); const entry = files.get(url.pathname);
      if (url.protocol !== 'app:' || url.hostname !== 'resources' || !entry) return new Response('', { status: 404 });
      return new Response(await fs.readFile(entry[0]), { headers: { 'Content-Type': entry[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    });
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = new BrowserWindow({
      title: 'MyGo · 汽水音乐官方安全验证', width: 520, height: 700, minWidth: 400, minHeight: 500,
      show: false, autoHideMenuBar: true,
      webPreferences: { session: this.ses, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    this.window.webContents.setUserAgent(UA);
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event, value) => { if (!value.startsWith(ORIGIN + '/auth/')) event.preventDefault(); });
    this.window.on('close', event => { event.preventDefault(); this.cancel(); this.window.hide(); });
    await this.window.loadURL(PAGE);
    const deadline = Date.now() + 30000;
    for (;;) {
      const state = await this.window.webContents.executeJavaScript('({ready:!!window.bdms&&!!window.qishui,version:window._sdkGlueVersionMap?.bdmsVersion})');
      if (state.ready && state.version === '1.0.0.41') break;
      if (Date.now() >= deadline) throw fault('sdk');
      await sleep(100);
    }
    this.browserInfo = await this.exec('browserInfo');
    this.msToken = await this.exec('storedToken');
    // Obtain the bootstrap token from the service/SDK, never invent a signature or token.
    if (!this.msToken) {
      await this.passport('/passport/web/get_qrcode/', { query: { next: API, need_logo: false, need_short_url: false } }, true);
      if (!this.issuedToken || this.issuedToken.length > 4096) throw fault('sdk');
      this.msToken = this.issuedToken; await this.exec('seed', this.msToken);
    }
    this.sdkReady = true;
  }
  exec(name, ...args) {
    if (!this.window || this.window.isDestroyed() || !['request', 'browserInfo', 'seed', 'storedToken', 'show', 'verify', 'cancel'].includes(name)) throw fault('sdk');
    return this.window.webContents.executeJavaScript(`window.qishui[${JSON.stringify(name)}](...${JSON.stringify(args)})`, true);
  }
  common() {
    const id = this.identity;
    return {
      aid: '386088', passport_jssdk_version: '2.4.13', passport_jssdk_type: 'normal', is_from_ttaccountsdk: '1', language: 'zh', account_sdk_source: 'web',
      p_js_v: '2.4.13', p_js_t: 'pro', p_zt: '3.3.5', p_ver: '1.0.29', request_host: encodeURIComponent(ORIGIN), p_bd: '1.0.0.41',
      biz_trace_id: crypto.randomBytes(4).toString('hex'), is_new_login: '1', is_from_iesaccountsaas: '1',
      device_id: id.deviceId, install_id: id.installId, did: id.deviceId, iid: id.installId, device_platform: 'PC', version_code: APP_VERSION,
      account_sdk_source_info: this.browserInfo, ...(this.msToken ? { msToken: this.msToken } : {}),
    };
  }
  async passport(pathname, options = {}, bootstrapping = false) {
    if (!bootstrapping) await this.ready();
    if (!/^\/passport\/[a-z0-9_/-]+\/?$/.test(pathname)) throw fault('protocol');
    const query = this.common(); const url = new URL(pathname, API);
    for (const [key, value] of Object.entries({ ...query, ...options.query })) url.searchParams.set(key, String(value));
    const cookies = await this.ses.cookies.get({ url: API });
    const csrf = cookies.find(c => c.name === 'passport_csrf_token')?.value || cookies.find(c => c.name === 'passport_csrf_token_default')?.value;
    const trace = crypto.randomBytes(16).toString('hex');
    const headers = { Accept: 'application/json, text/javascript', 'x-tt-passport-verify-portrait': this.identity.portraitId, 'x-tt-passport-trace-id': query.biz_trace_id, 'x-tt-trace-id': `00-${trace}-${trace.slice(0, 16)}-01`, ...(csrf ? { 'x-tt-passport-csrf-token': csrf } : {}) };
    const body = options.body ? new URLSearchParams(options.body).toString() : null;
    if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers['x-ss-stub'] = crypto.createHash('md5').update(body).digest('hex').toUpperCase(); }
    let result;
    try { result = await this.exec('request', { method: body ? 'POST' : 'GET', url: url.href, headers, body }); }
    catch { this.signedRequests.delete(query.biz_trace_id); throw fault(this.controller?.signal.aborted ? 'cancelled' : 'network'); }
    const signedURL = this.signedRequests.get(query.biz_trace_id); this.signedRequests.delete(query.biz_trace_id);
    const observed = signedURL && new URL(signedURL);
    this.observed = signedURL ? { url: signedURL } : null;
    if (!observed || observed.pathname !== pathname || (observed.searchParams.get('a_bogus') || '').length !== 44 ||
        (!bootstrapping && !observed.searchParams.get('msToken'))) throw fault('sdk');
    if (this.issuedToken && this.issuedToken !== this.msToken) {
      this.msToken = this.issuedToken; await this.exec('seed', this.msToken);
    }
    return parseJSON(result.body, result.status);
  }
  async cookieHeader() {
    await this.base();
    return (await this.ses.cookies.get({ url: API })).filter(c => c.value).map(c => `${c.name}=${c.value}`).join('; ');
  }
  async importCookies(raw) {
    if (typeof raw !== 'string' || raw.length > 32768) throw fault('response');
    for (const pair of raw.split(';')) {
      const at = pair.indexOf('='); if (at < 1) continue;
      const name = pair.slice(0, at).trim(), value = pair.slice(at + 1).trim();
      if (!/^[A-Za-z0-9_!-]+$/.test(name) || !value || /[\r\n]/.test(value)) continue;
      await this.ses.cookies.set({ url: API, domain: '.qishui.com', path: '/', name, value, secure: true, httpOnly: /^(sessionid|sid_)/.test(name), sameSite: 'no_restriction' });
    }
  }
  async exchange(raw) {
    let url = new URL(raw, API);
    for (let hop = 0; hop < 5; hop++) {
      if (url.protocol !== 'https:' || url.username || url.password || !(url.hostname === 'qishui.com' || url.hostname.endsWith('.qishui.com'))) throw fault('response');
      const response = await this.ses.fetch(url.href, { credentials: 'include', redirect: 'manual', signal: AbortSignal.timeout(20000) });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) { url = new URL(location, url); continue; }
      if (!response.ok) throw fault('network', { httpStatus: response.status });
      await response.body?.cancel(); return;
    }
    throw fault('response');
  }
  loadNative() {
    if (this.nativeLoaded) return this.native;
    this.nativeLoaded = true;
    if (process.platform === "darwin" && process.arch === "arm64") {
      try {
        const sdk = require("/Applications/汽水音乐.app/Contents/Resources/app.asar.unpacked/bdms.node");
        if (typeof sdk.init === "function" && typeof sdk.generateHttpSignatureHeaders === "function") { sdk.init({ deviceId: this.identity.deviceId }); this.native = sdk; }
      } catch { this.native = null; }
    } else if (process.platform === "win32") {
      const candidates = [
        path.join(this.dataDir, "vendor", "bdms.node"),
        path.join(process.env.LOCALAPPDATA || "", "Programs", "SodaMusic", "resources", "app.asar.unpacked", "bdms.node"),
        path.join(process.env.ProgramFiles || "", "SodaMusic", "resources", "app.asar.unpacked", "bdms.node"),
        path.join(process.env["ProgramFiles(x86)"] || "", "SodaMusic", "resources", "app.asar.unpacked", "bdms.node")
      ];
      for (const cand of candidates) {
        try {
          const sdk = require(cand);
          if (typeof sdk.init === "function" && typeof sdk.generateHttpSignatureHeaders === "function") {
            sdk.init({ deviceId: this.identity.deviceId });
            this.native = sdk;
            break;
          }
        } catch {}
      }
    }
    return this.native;
  }
  async api(pathname, params = {}, body, signal) {
    signal = signal || featureContext.getStore()?.signal;
    signal?.throwIfAborted();
    await this.base();
    signal?.throwIfAborted();
    const url = apiURL(pathname, params);
    const common = {
      aid: '386088', app_name: 'luna_pc', region: 'cn', geo_region: 'cn', os_region: 'cn', sim_region: '',
      device_id: this.identity.deviceId, iid: this.identity.installId, fp: this.identity.deviceId, cdid: '',
      version_name: APP_VERSION, version_code: '30050200', channel: 'official', build_mode: 'master',
      network_carrier: '', ac: 'wifi', tz_name: 'Asia/Shanghai', resolution: '',
      device_platform: process.platform === 'darwin' ? 'mac' : 'windows', device_type: process.platform === 'darwin' ? 'Mac' : 'Windows',
      os_version: process.platform === 'darwin' ? 'macOS' : 'Windows 11',
    };
    for (const [key, value] of Object.entries(common)) url.searchParams.set(key, value);
    const sdk = this.loadNative(); if (!sdk) throw fault('setup');
    const ua = 'LunaPC/' + APP_VERSION, text = body === undefined ? null : JSON.stringify(body);
    const lines = ['user-agent\r\n' + ua];
    if (text) lines.push('X-SS-STUB\r\n' + crypto.createHash('md5').update(text).digest('hex').toUpperCase());
    const signature = String(sdk.generateHttpSignatureHeaders(url.href, lines.join('\r\n'))).split('\r\n').filter(Boolean);
    const headers = { 'User-Agent': ua, Cookie: await this.cookieHeader(), ...(text ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) };
    for (let index = 0; index + 1 < signature.length; index += 2) if (/^x-[a-z0-9-]+$/i.test(signature[index])) headers[signature[index]] = signature[index + 1];
    if (!Object.keys(headers).some(k => /^x-(helios|medusa|neptune)$/i.test(k))) throw fault('sdk');
    signal?.throwIfAborted();
    let response;
    try { response = await fetch(url, { method: text ? 'POST' : 'GET', headers, body: text, redirect: 'error', signal: signal || AbortSignal.timeout(20000) }); }
    catch { throw fault('network'); }
    return checkPacket(parseJSON(await response.text(), response.status));
  }
  async finish() {
    const cookie = await this.cookieHeader(); if (!hasSession(cookie)) throw fault('session');
    let account;
    try { account = profileOf(await this.api('/luna/pc/me')); }
    catch {
      // The Passport SDK exposes this as getUserInfo; it still must verify a real uid.
      const packet = await this.passport('/passport/account/info/v2/'); account = profileOf(packet);
    }
    await this.ses.cookies.flushStore();
    return { cookie: await this.cookieHeader(), account };
  }
  async verify(decision) {
    let expanded = decision;
    if (decision.verify_from === 'verify_center') {
      const body = { aid: '386088', ...decision, device_id: this.identity.deviceId, install_id: this.identity.installId, device_platform: 'PC', version_code: APP_VERSION };
      delete body.is_login;
      for (const key of Object.keys(body)) if (typeof body[key] === 'object') body[key] = JSON.stringify(body[key]);
      const packet = checkPacket(await this.passport('/passport/safe/pack_verify_ways_data/', { body }));
      expanded = { ...decision, ...(packet.data || packet) };
    }
    this.window.setTitle('MyGo · 汽水官方安全验证'); this.window.setSize(980, 760); this.window.center(); this.window.show(); this.window.focus();
    try { return await this.exec('verify', expanded, { device_id: this.identity.deviceId, install_id: this.identity.installId, did: this.identity.deviceId, iid: this.identity.installId, device_platform: 'PC', version_code: APP_VERSION }); }
    catch { throw fault(this.controller?.signal.aborted ? 'cancelled' : 'verification'); }
    finally { if (this.window && !this.window.isDestroyed()) this.window.hide(); }
  }
  async signIn(showWindow = false) {
    if (this.locked || this.resetting) throw fault('busy'); this.locked = true; this.controller = new AbortController();
    this.features.reset();
    const timer = setTimeout(() => this.cancel(), 240000);
    try {
      return await runLogin({
        signal: this.controller.signal, platform: process.platform, computerName: 'MyGo Music', ready: () => this.ready(),
        restore: async () => {
          if (!hasSession(await this.cookieHeader())) return null;
          try { return await this.finish(); } catch (e) { if (['network', 'timeout'].includes(e.code)) throw e; await this.ses.clearStorageData({ storages: ['cookies'] }); return null; }
        },
        createQR: () => this.passport('/passport/web/get_qrcode/', { query: { next: API, need_logo: false, need_short_url: false } }),
        poll: (token, options) => this.passport('/passport/web/check_qrconnect/', { query: options.resend ? { isResend: 'true' } : {}, body: { need_logo: 'false', need_short_url: 'false', is_frontier: 'true', token, is_new_login: '1', next: API, ...options.biz } }),
        importCookies: raw => this.importCookies(raw), exchange: value => this.exchange(value), finish: () => this.finish(), verify: data => this.verify(data), sleep,
        progress: event => {
          this.emit(event);
          if (this.window && !this.window.isDestroyed()) {
            const update = async () => { const image = event.qr && showWindow ? await this.qrcode.toDataURL(event.qr) : null; await this.exec('show', event.text, image); if (showWindow && event.qr) { this.window.show(); this.window.focus(); } };
            update().catch(() => {});
          }
        },
      });
    } finally {
      clearTimeout(timer); this.locked = false; this.controller = null;
      if (this.window && !this.window.isDestroyed()) this.window.hide();
    }
  }
  async account() { await this.base(); return hasSession(await this.cookieHeader()) ? this.finish() : null; }
  async featureAccount() {
    if (this.locked || this.resetting) throw fault('busy');
    return profileOf(await this.api('/luna/pc/me'));
  }
  catalog(params) {
    if (this.locked || this.resetting) throw fault('busy');
    return this.features.dispatch(params);
  }
  cancel() {
    this.features.reset();
    this.controller?.abort();
    if (this.window && !this.window.isDestroyed()) this.exec('cancel').catch(() => {});
  }
  async stream(params) {
    if (this.locked || this.resetting) throw fault('busy');
    if (!hasSession(await this.cookieHeader())) throw fault('session');
    return this.playback.prepare(params);
  }
  async signOut() {
    if (this.resetting) throw fault('busy');
    this.resetting = true;
    this.cancel();
    try {
      await this.base();
      await this.playback.close();
      this.playback = new Playback({ dataDir: this.dataDir, api: (...args) => this.api(...args) });
      if (this.window && !this.window.isDestroyed()) this.window.destroy();
      await this.ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] });
      this.msToken = ''; this.issuedToken = ''; this.sdkReady = false;
    } finally { this.features.reset(); this.resetting = false; }
  }

  async close() {
    this.cancel(); if (this.window && !this.window.isDestroyed()) this.window.destroy();
    await this.playback.close();
  }
  async probe() {
    await this.ready();
    const packet = checkPacket(await this.passport('/passport/web/get_qrcode/', { query: { next: API, need_logo: false, need_short_url: false } }));
    const polled = checkPacket(await this.passport('/passport/web/check_qrconnect/', { body: { token: packet.data.token, next: API, need_logo: 'false', need_short_url: 'false', is_frontier: 'true', is_new_login: '1' } }));
    const url = new URL(this.observed.url);
    return { sdkReady: this.sdkReady, signed: (url.searchParams.get('a_bogus') || '').length === 44, serverTokenPresent: url.searchParams.has('msToken'), status: ['new', 'scanned', 'confirmed', 'expired'].includes(polled.data?.status) ? polled.data.status : 'unknown', nativeAvailable: Boolean(this.loadNative()) };
  }
}
module.exports = { Runtime, profileOf, checkPacket, API, PAGE };
