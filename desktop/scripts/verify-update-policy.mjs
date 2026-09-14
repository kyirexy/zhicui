import assert from 'node:assert/strict';
import { nativeUpdateCheckDisposition, NativeUpdateController } from '../dist/update-policy.js';

assert.equal(
  nativeUpdateCheckDisposition({
    packaged: false,
    hasInFlightCheck: false,
    status: 'idle',
  }),
  'unsupported',
  'development must never contact the native update feed',
);

assert.equal(
  nativeUpdateCheckDisposition({
    packaged: true,
    hasInFlightCheck: true,
    status: 'checking',
  }),
  'reuse',
  'concurrent checks must share the active operation',
);

for (const status of ['downloading', 'installing']) {
  assert.equal(
    nativeUpdateCheckDisposition({
      packaged: true,
      hasInFlightCheck: false,
      status,
    }),
    'hold',
    `status ${status} must not start another download`,
  );
}

assert.equal(
  nativeUpdateCheckDisposition({
    packaged: true,
    hasInFlightCheck: false,
    status: 'current',
  }),
  'check',
);

console.log('desktop update policy verification passed');

assert.equal(nativeUpdateCheckDisposition({ packaged: true, hasInFlightCheck: false, status: 'downloaded' }), 'check',
  '已下载仍须允许核对最新目标，不能一直停留在上次旧包');

const info = (version) => ({ version, files: [{ url: `Zhicui-Setup-${version}-x64.exe`, sha512: `fixture-${version}`, size: 100 }] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let tick = 0; tick < 30; tick++) await Promise.resolve(); };
const failure = (code) => Object.assign(new Error('内部路径/token等不能进入状态'), { code });

function fixture(options = {}) {
  let head = info('1.1.10');
  let checked;
  let cached = null;
  let downloads = 0, checks = 0, validations = 0;
  const installs = [], states = [];
  const adapter = {
    check: async () => { checks++; if (options.check) await options.check(); checked = structuredClone(head);
      return { isUpdateAvailable: true, updateInfo: checked }; },
    download: async () => { downloads++; const target = checked;
      if (options.download) await options.download();
      cached = target;
      controller.downloadedEvent(options.wrongEvent ? info('1.0.0') : target);
      return ['fixture-path']; },
    validate: async (target) => { validations++; if (options.validate) await options.validate();
      assert.equal(target.version, cached?.version); },
    hasCachedFile: () => Boolean(cached),
    newer: (left, right) => {
      const a = left.split('.').map(Number), b = right.split('.').map(Number);
      for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
      return false;
    },
    install: () => { if (options.install) options.install(); installs.push(cached.version); },
  };
  const controller = new NativeUpdateController(adapter, '1.1.9', options.capability || { supported: true }, (state) => states.push(state));
  return { controller, adapter, states, installs, options, setHead: (value) => { head = value; },
    clearCache: () => { cached = null; }, counts: () => ({ downloads, checks, validations }) };
}

let cases = 0;
{
  const f = fixture({ capability: { supported: false, code: 'UPDATE_SIGNATURE_REQUIRED', manualRequired: true } });
  assert.equal((await f.controller.check()).status, 'unsupported');
  assert.equal((await f.controller.install()).manualRequired, true);
  assert.deepEqual(f.counts(), { checks: 0, downloads: 0, validations: 0 }); cases++;
}
{
  const gate = deferred(); const f = fixture({ check: () => gate.promise });
  const first = f.controller.check(), second = f.controller.check();
  assert.equal(first, second); gate.resolve(); await first; await flush();
  assert.equal(f.counts().checks, 1); assert.equal(f.counts().downloads, 1);
  assert.equal(f.controller.getState().status, 'downloaded'); cases++;
}
{
  const gate = deferred(); const f = fixture({ download: () => gate.promise });
  await f.controller.check(); await flush();
  assert.equal(f.controller.getState().status, 'downloading');
  await f.controller.check();
  assert.equal((await f.controller.install()).status, 'downloading', '过早点击不能破坏下载状态');
  f.controller.progress({ percent: NaN, transferred: -1, total: 100, bytesPerSecond: Infinity });
  assert.equal(f.controller.getState().percent, 0);
  gate.resolve(); await flush();
  assert.equal(f.counts().checks, 1); assert.equal(f.counts().downloads, 1);
  assert.equal(f.controller.getState().canInstall, true); cases++;
}
{
  const gate = deferred(); const f = fixture({ validate: () => gate.promise });
  await f.controller.check(); await flush();
  assert.equal(f.controller.getState().status, 'downloading', '下载事件不是校验完成');
  gate.resolve(); await flush(); assert.equal(f.controller.getState().status, 'downloaded'); cases++;
}
{
  const f = fixture({ wrongEvent: true }); await f.controller.check(); await flush();
  assert.equal(f.controller.getState().code, 'UPDATE_TARGET_MISMATCH');
  assert.equal(f.controller.getState().canInstall, false); assert.deepEqual(f.installs, []); cases++;
}
{
  const f = fixture(); f.setHead(info('1.1.8')); await f.controller.check(); await flush();
  assert.equal(f.counts().downloads, 0); assert.equal(f.controller.getState().installedVersion, '1.1.9'); cases++;
}
{
  const f = fixture(); await f.controller.check(); await flush();
  f.controller.updaterError(failure('LATE_OLD_ERROR'));
  f.controller.progress({ percent: 5, transferred: 5, total: 100, bytesPerSecond: 2 });
  f.controller.downloadedEvent(info('1.0.1'));
  assert.equal(f.controller.getState().status, 'downloaded');
  assert.equal(f.controller.getState().version, '1.1.10'); cases++;
}
{
  const f = fixture(); await f.controller.check(); await flush();
  const before = f.counts().downloads;
  await f.controller.check(); await flush();
  assert.equal(f.counts().downloads, before, '相同目标复用完整缓存，不重复下载');
  f.setHead(info('1.1.11'));
  await f.controller.check(); await flush();
  assert.equal(f.controller.getState().version, '1.1.11');
  assert.equal(f.counts().downloads, before + 1); cases++;
}
{
  const f = fixture(); await f.controller.check(); await flush(); f.setHead(info('1.1.11'));
  const first = f.controller.install(), second = f.controller.install();
  assert.equal(first, second); await first; await flush();
  assert.deepEqual(f.installs, ['1.1.11'], '安装前发现新版时直接准备最新目标');
  assert.equal(f.controller.getState().status, 'installing');
  await f.controller.install(); assert.equal(f.installs.length, 1); cases++;
}
{
  let failed = true;
  const f = fixture({ install: () => { if (failed) throw failure('EACCES'); } });
  await f.controller.check(); await flush();
  assert.equal((await f.controller.install()).status, 'downloaded');
  assert.equal(f.controller.getState().canInstall, true);
  failed = false; await f.controller.install();
  assert.equal(f.counts().downloads, 1); assert.equal(f.installs.length, 1); cases++;
}
{
  const f = fixture(); await f.controller.check(); await flush(); await f.controller.install();
  f.controller.updaterError(failure('EACCES'));
  assert.equal(f.controller.getState().status, 'downloaded');
  await f.controller.install(); assert.equal(f.counts().downloads, 1); assert.equal(f.installs.length, 2); cases++;
}
{
  let fail = true;
  const f = fixture({ download: async () => { if (fail) throw failure('NETWORK'); } });
  await f.controller.check(); await flush(); assert.equal(f.controller.getState().status, 'error');
  fail = false; await f.controller.check(); await flush();
  assert.equal(f.controller.getState().status, 'downloaded'); assert.equal(f.counts().downloads, 2); cases++;
}
{
  const f = fixture({ validate: async () => { throw failure('ERR_UPDATER_INVALID_SIGNATURE'); } });
  await f.controller.check(); await flush();
  assert.equal(f.controller.getState().manualRequired, true);
  assert.equal(f.controller.getState().canInstall, false); await f.controller.install();
  assert.deepEqual(f.installs, []); assert.equal(JSON.stringify(f.controller.getState()).includes('token'), false); cases++;
}
{
  const f = fixture(); await f.controller.check(); await flush(); f.clearCache();
  assert.equal((await f.controller.install()).code, 'UPDATE_FILE_MISSING');
  await f.controller.check(); await flush(); assert.equal(f.counts().downloads, 2);
  assert.equal(f.controller.getState().canInstall, true); cases++;
}
{
  const f = fixture(); await f.controller.check(); await flush();
  const changed = info('1.1.10'); changed.files[0].sha512 = 'changed'; f.setHead(changed);
  await f.controller.install(); assert.equal(f.controller.getState().code, 'UPDATE_TARGET_MISMATCH');
  assert.deepEqual(f.installs, []); cases++;
}
{
  const f = fixture(); await f.controller.check(); await flush();
  f.setHead(info('1.1.8')); await f.controller.check(); await flush();
  assert.equal(f.controller.getState().version, '1.1.10'); assert.equal(f.counts().downloads, 1); cases++;
}
{
  const f = fixture(); await f.controller.check(); await flush();
  const gate = deferred(); f.options.validate = () => gate.promise;
  const install = f.controller.install(); await flush();
  const checks = f.counts().checks;
  f.setHead(info('1.1.11')); await f.controller.check();
  assert.equal(f.counts().checks, checks, '安装校验过程中其它入口不能启动新的检测并改写目标');
  gate.resolve(); await install;
  assert.deepEqual(f.installs, ['1.1.10']); cases++;
}
{
  const f = fixture(); await f.controller.check(); await flush();
  const validations = f.counts().validations;
  f.options.check = async () => { throw failure('NETWORK'); };
  assert.equal((await f.controller.install()).status, 'installing');
  assert.deepEqual(f.installs, ['1.1.10'], '安装前网络离线仍能安装此前下载且再次校验的明确版本');
  assert.equal(f.counts().downloads, 1);
  assert.ok(f.counts().validations > validations, '离线不能跳过已下载文件验证'); cases++;
}
console.log(JSON.stringify({ updater_state_cases: cases, verified: true, installers_executed: 0 }));
