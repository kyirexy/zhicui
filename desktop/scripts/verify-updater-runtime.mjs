import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const compiled = readFileSync(new URL('../dist/updater.js', import.meta.url), 'utf8');
const root = mkdtempSync(join(tmpdir(), 'zhicui-updater-fixture-'));
let cases = 0;
async function fixture({ enabled = true, publisher = true, validSignature = true, corrupt = false, strict = 'valid' } = {}) {
  const dir = join(root, String(cases++)); mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ nativeUpdatesEnabled: enabled }));
  writeFileSync(join(dir, 'app-update.yml'), publisher ? 'publisherName: Synthetic Publisher\n' : 'provider: generic\n');
  const bytes = Buffer.from('合成文件，仅校验，不可执行');
  const path = join(dir, 'Zhicui-Setup-1.1.10-x64.exe');
  const info = { version: '1.1.10', files: [{ url: 'Zhicui-Setup-1.1.10-x64.exe', size: bytes.length,
    sha512: createHash('sha512').update(bytes).digest('base64') }] };
  const updater = new EventEmitter();
  let checks = 0, downloads = 0, signatures = 0, strictSignatures = 0;
  const installs = [];
  Object.defineProperty(updater, 'channel', { set(value) { this.assignedChannel = value; this.allowDowngrade = true; } });
  updater.installerPath = path;
  updater.checkForUpdates = async () => { checks++; return { isUpdateAvailable: true, updateInfo: info }; };
  updater.downloadUpdate = async () => {
    downloads++;
    writeFileSync(path, corrupt ? Buffer.alloc(bytes.length, 1) : bytes);
    updater.emit('update-downloaded', { ...info, downloadedFile: path });
    return [path];
  };
  updater.verifyUpdateCodeSignature = async (names, actualPath) => {
    signatures++;
    assert.deepEqual(Array.from(names), ['Synthetic Publisher']); assert.equal(actualPath, path);
    return validSignature ? null : 'synthetic unsigned result';
  };
  updater.quitAndInstall = (...args) => { installs.push(args); };
  const strictExecFile = (command, args, options, callback) => {
    strictSignatures++;
    assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 20_000); assert.equal(options.maxBuffer, 64 * 1024);
    assert.equal(options.env.ZHICUI_UPDATE_INSTALLER_PATH, path);
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /-LiteralPath \$env:ZHICUI_UPDATE_INSTALLER_PATH/);
    assert.equal(script.includes(path), false, '本机路径不能插入 PowerShell 命令文本');
    if (strict === 'actual-unsigned') return require('node:child_process').execFile(command, args, options, callback);
    if (strict === 'error' || strict === 'timeout') return callback(Object.assign(new Error('synthetic failure'), { code: strict === 'timeout' ? 'ETIMEDOUT' : 'ENOENT' }), '', '');
    if (strict === 'stderr') return callback(null, '', 'synthetic warning');
    if (strict === 'empty' || strict === 'malformed') return callback(null, strict === 'empty' ? '' : '{broken}', '');
    const result = { status: 0, path, subject: 'CN=Synthetic Publisher, O=Synthetic Publisher', thumbprint: 'a'.repeat(40) };
    if (strict === 'unsigned') result.status = 2;
    if (strict === 'missing') delete result.subject;
    if (strict === 'bad-certificate') result.thumbprint = '';
    if (strict === 'wrong-publisher') result.subject = 'CN=Other Publisher';
    if (strict === 'wrong-path') result.path += '.another.exe';
    if (strict === 'status-string') result.status = '0';
    callback(null, JSON.stringify(result), '');
  };
  const exports = {};
  const context = vm.createContext({
    exports, require: (name) => name === 'electron' ? { app: { isPackaged: true, getVersion: () => '1.1.9', getAppPath: () => dir } }
      : name === 'electron-updater' ? { autoUpdater: updater }
        : name === 'node:child_process' ? { execFile: strictExecFile }
        : name === './update-policy' ? require('../dist/update-policy.js') : require(name),
    process: { platform: 'win32', resourcesPath: dir, env: { SystemRoot: 'C:\\Windows' } }, Buffer,
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(compiled, context);
  const states = [];
  exports.initializeDesktopUpdater((state) => states.push(state), 'beta');
  assert.equal(updater.assignedChannel, 'beta');
  assert.equal(updater.allowDowngrade, false, 'channel setter 的降级开关必须重新关闭');
  assert.equal(updater.autoDownload, false, '下载由受控 promise 自动启动');
  assert.equal(updater.autoInstallOnAppQuit, false, '关闭应用不能跳过安装前验证');
  assert.equal(updater.disableWebInstaller, true);
  await exports.checkForDesktopUpdates();
  for (let i = 0; i < (strict === 'actual-unsigned' ? 5000 : 100) && ['checking', 'available', 'downloading'].includes(exports.getDesktopUpdateState().status); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { exports, updater, states, installs, stats: () => ({ checks, downloads, signatures, strictSignatures }) };
}

try {
  for (const options of [{ enabled: false }, { publisher: false }]) {
    const f = await fixture(options);
    assert.equal(f.exports.getDesktopUpdateState().status, 'unsupported');
    assert.equal(f.exports.getDesktopUpdateState().manualRequired, true);
    assert.deepEqual(f.stats(), { checks: 0, downloads: 0, signatures: 0, strictSignatures: 0 });
    assert.equal((await f.exports.installDesktopUpdate()).canInstall, false);
  }
  {
    const f = await fixture({ corrupt: true });
    assert.equal(f.exports.getDesktopUpdateState().code, 'UPDATE_TARGET_MISMATCH');
    assert.equal(f.stats().signatures, 0);
    await f.exports.installDesktopUpdate(); assert.equal(f.installs.length, 0);
  }
  {
    const f = await fixture({ validSignature: false });
    assert.equal(f.exports.getDesktopUpdateState().code, 'ERR_UPDATER_INVALID_SIGNATURE');
    assert.equal(f.exports.getDesktopUpdateState().manualRequired, true);
    assert.equal(f.stats().signatures, 1);
    await f.exports.installDesktopUpdate(); assert.equal(f.installs.length, 0);
  }
  {
    const f = await fixture();
    assert.equal(f.exports.getDesktopUpdateState().status, 'downloaded');
    assert.equal(f.stats().signatures, 1);
    await Promise.all([f.exports.installDesktopUpdate(), f.exports.installDesktopUpdate()]);
    assert.deepEqual(f.installs, [[true, true]], '只调用一次静默安装+重新运行');
    assert.equal(f.stats().downloads, 1);
    assert.ok(f.stats().signatures >= 2, '缓存安装前必须再次验证签名');
    assert.ok(f.stats().strictSignatures >= 2, '默认 verifier 的 null 必须再次以严格结果核验');
    assert.equal(f.exports.getDesktopUpdateState().status, 'installing');
  }
  for (const strict of ['error', 'timeout', 'stderr', 'empty', 'malformed', 'missing', 'status-string', 'unsigned', 'bad-certificate', 'wrong-publisher', 'wrong-path']) {
    const f = await fixture({ strict });
    assert.equal(f.stats().signatures, 1, '模拟原 verifier 返回 null');
    assert.equal(f.stats().strictSignatures, 1);
    assert.equal(f.exports.getDesktopUpdateState().status, 'error', strict);
    assert.equal(f.exports.getDesktopUpdateState().manualRequired, true, strict);
    assert.equal(f.exports.getDesktopUpdateState().canInstall, false, strict);
    await f.exports.installDesktopUpdate(); assert.equal(f.installs.length, 0, strict);
  }
  if (process.platform === 'win32') {
    const f = await fixture({ strict: 'actual-unsigned' });
    assert.equal(f.exports.getDesktopUpdateState().status, 'error');
    assert.equal(f.exports.getDesktopUpdateState().manualRequired, true);
    assert.equal(f.stats().strictSignatures, 1, '真实 PowerShell 只检查隔离合成文件，无安装程序执行');
    assert.equal(f.installs.length, 0);
  }
  let agentCases = 0;
  for (const status of ['error', 'downloaded', 'unsupported', 'installing']) {
    const exports = {};
    let installCalls = 0;
    const context = vm.createContext({ exports, process, Buffer,
      require: (name) => name === 'electron' ? { dialog: { showMessageBox: async () => ({ response: 1 }) } }
        : name === './updater' ? {
          getDesktopUpdateState: () => ({ status: 'downloaded', installedVersion: '1.1.9' }),
          installDesktopUpdate: async () => { installCalls++; return { status, installedVersion: '1.1.9' }; },
        } : name.startsWith('./') ? require('../dist/' + name.slice(2) + '.js') : require(name),
    });
    vm.runInContext(readFileSync(new URL('../dist/agent-action-bridge.js', import.meta.url), 'utf8'), context);
    const bridge = new exports.DesktopAgentActionBridge({ version: '1.1.9', channel: 'beta', getWindow: () => null, getMediaLibrary: () => null });
    const result = await bridge.invoke('local.update.install', {});
    assert.equal(result.status, status === 'installing' ? 'succeeded' : 'failed', 'Agent 不能把签名拒绝或未发起安装报成功');
    assert.equal(result.data.status, status); assert.equal(installCalls, 1); agentCases++;
  }
  console.log(JSON.stringify({ verified: true, runtime_cases: cases, actual_file_hash_verified: true,
    agent_action_cases: agentCases, signature_results: 'synthetic valid/failure cases; Windows also real unsigned file rejection', installers_executed: 0, real_user_cache_read: false }));
} finally {
  // 只删除当前测试在系统临时目录创建的固定根，不触及用户安装包或更新缓存。
  assert.ok(root.startsWith(join(tmpdir(), 'zhicui-updater-fixture-')));
  rmSync(root, { recursive: true, force: true });
}
