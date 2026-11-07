'use strict';
// Explicit setup: never install into the plugin code folder (MyGo rejects dependency symlinks).
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runtimeLayout, defaultDataDir, loadRuntime, validatePackages } = require('./dependencies.cjs');
const { fault } = require('./protocol.cjs');

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_SKIP_BINARY_DOWNLOAD', 'ELECTRON_OVERRIDE_DIST_PATH', 'ELECTRON_INSTALL_PLATFORM', 'ELECTRON_INSTALL_ARCH']) delete env[key];
    if (!env.ELECTRON_MIRROR) env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
    const isCmd = process.platform === 'win32' && (command.endsWith('.cmd') || command.endsWith('.bat'));
    const child = spawn(command, args, { cwd, env, shell: isCmd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(fault('setup')));
  });
}
async function installRuntime({ dataDir = defaultDataDir(), sourceDir = __dirname, run = runCommand, report = console.log } = {}) {
  const layout = runtimeLayout(dataDir, sourceDir);
  try {
    const installed = loadRuntime(dataDir, sourceDir);
    report('运行时已就绪（代码更新无需重新安装依赖）：' + installed.root);
    return installed;
  } catch { /* First setup or a damaged dependency installation. */ }
  await fs.mkdir(layout.root, { recursive: true, mode: 0o700 });
  await fs.chmod(layout.root, 0o700);
  const lockFile = path.join(layout.root, '.install.lock');
  let handle;
  try { handle = await fs.open(lockFile, 'wx', 0o600); } catch { throw fault('setup'); }
  try {
    await fs.rm(path.join(layout.root, 'ready.json'), { force: true });
    const manifest = { name: 'mygo-qishui-sdk-runtime', version: '1.0.0', private: true, dependencies: layout.manifest.dependencies };
    const lock = { ...layout.lock, name: manifest.name, version: manifest.version, packages: { ...layout.lock.packages, '': manifest } };
    await fs.writeFile(path.join(layout.root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    await fs.writeFile(path.join(layout.root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n', { mode: 0o600 });
    report('依赖安装位置（不在插件代码目录中）：' + layout.root);
    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], layout.root);
    // Electron's pinned installer verifies the binary checksums. No other dependency install scripts run.
    await run(process.execPath, [path.join(layout.root, 'node_modules/electron/install.js')], layout.root);
    validatePackages(layout);
    const marker = path.join(layout.root, 'ready.json.tmp');
    await fs.writeFile(marker, JSON.stringify({ key: layout.key }), { mode: 0o600 });
    await fs.rename(marker, path.join(layout.root, 'ready.json'));
    report('运行时准备完成。插件代码目录未写入 node_modules，登录数据未改动。');
    return loadRuntime(dataDir, sourceDir);
  } finally {
    await handle.close();
    await fs.rm(lockFile, { force: true });
  }
}
async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw fault('setup');
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--data-dir' || !path.isAbsolute(args[1]))) throw fault('setup');
  await installRuntime({ dataDir: args.length ? args[1] : defaultDataDir() });
}
if (require.main === module) main().catch(() => { console.error('运行时安装未完成：请检查 Node 22.12+、npm、网络及上方安装输出。不要在插件目录执行 npm install/ci。'); process.exitCode = 1; });
module.exports = { installRuntime };
