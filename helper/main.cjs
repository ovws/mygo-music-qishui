'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Runtime } = require('./runtime.cjs');
const { parseRequest, encodeResponse, publicError, fault, MAX_LINE_BYTES } = require('./protocol.cjs');
if (process.env.MYGO_QISHUI_HELPER !== '1') app.exit(1);
const at = process.argv.indexOf('--data-dir');
const dataDir = at >= 0 ? process.argv[at + 1] : '';
if (!dataDir || !path.isAbsolute(dataDir)) app.exit(1);
app.setName('MyGo Qishui Auth');
app.setPath('userData', dataDir);
const output = fs.createWriteStream(null, { fd: 3, autoClose: false });
const send = value => output.write(encodeResponse(value));
let runtime, loginId = null, quitting = false, buffer = '';
async function quit() {
  if (quitting) return; quitting = true;
  await runtime?.close().catch(() => {});
  app.quit();
}
async function dispatch(request) {
  const { id, op, params } = request;
  try {
    let result;
    if (op === 'hello') result = { protocol: 1, version: '0.4.5', platform: process.platform, arch: process.arch };
    else if (op === 'signIn') {
      if (loginId !== null) throw fault('busy'); loginId = id;
      try { result = await runtime.signIn(params.showWindow === true); } finally { loginId = null; }
    } else if (op === 'account') result = loginId !== null ? null : await runtime.account();
    else if (op === 'signOut') { await runtime.signOut(); result = null; }
    else if (op === 'request') {
      if (loginId !== null) throw fault('busy');
      result = await runtime.api(params.path, params.params || {}, params.body);
    } else if (op === 'catalog') {
      if (loginId !== null) throw fault('busy'); result = await runtime.catalog(params);
    } else if (op === 'stream') {
      if (loginId !== null) throw fault('busy'); result = await runtime.stream(params);
    } else if (op === 'probe') {
      if (loginId !== null) throw fault('busy'); result = await runtime.probe();
    } else if (op === 'shutdown') {
      runtime.cancel(); send({ id, ok: true, result: null }); await quit(); return;
    } else throw fault('protocol');
    send({ id, ok: true, result });
  } catch (error) { send({ id, ok: false, error: publicError(error) }); }
}
async function start() {
  if (!app.requestSingleInstanceLock()) throw fault('busy');
  await app.whenReady(); app.dock?.hide();
  runtime = new Runtime(dataDir, event => { if (loginId !== null) send({ id: loginId, event: 'prompt', ...event }); });
  await runtime.base();
  try {
    const storageFile = path.join(dataDir, '..', 'storage.json');
    if (fs.existsSync(storageFile)) {
      const storage = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
      if (storage.cookie) {
        await runtime.importCookies(storage.cookie);
        await runtime.ses.cookies.flushStore();
      }
    }
  } catch (e) {}
  const input = process.platform === 'win32'
    ? fs.createReadStream(null, { fd: 4, autoClose: false })
    : process.stdin;
  input.setEncoding('utf8');
  input.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      let request;
      try { request = parseRequest(line); }
      catch { output.write(JSON.stringify({ event: 'fatal', error: publicError(fault('protocol')) }) + '\n'); quit(); return; }
      dispatch(request).catch(() => quit());
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) quit();
  });
  input.on('end', () => quit());
  input.on('error', () => quit());
}
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; runtime?.cancel(); });
process.on('SIGTERM', () => quit());
process.on('uncaughtException', () => quit());
process.on('unhandledRejection', () => quit());
start().catch(error => {
  output.write(JSON.stringify({ event: 'fatal', error: publicError(error) }) + '\n');
  quit();
});
