import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DesktopAgentIntegration,
  resolveBundledCliEntry,
} from '../dist/agent-integration.js';
import {
  CrossProcessActionLock,
  LocalActionBusyError,
  desktopUserHash,
  localPlatformLockKey,
  normalizeLocalPlatformResult,
  platformSessionPath,
} from '../dist/desktop-core.js';
import {
  DesktopMediaLibrary,
  desktopMediaProfileDirectory,
} from '../dist/media-library.js';
import { validateDesktopAgentIntegrationRequest } from '../dist/security.js';

const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));
const desktopRoot = resolve(scriptDirectory, '..');

assert.deepEqual(
  validateDesktopAgentIntegrationRequest({ client: 'codex', operation: 'setup' }),
  { client: 'codex', operation: 'setup' },
);
assert.deepEqual(
  validateDesktopAgentIntegrationRequest({ client: 'claude', operation: 'doctor' }),
  { client: 'claude', operation: 'doctor' },
);
for (const unsafe of [
  { client: 'codex', operation: 'setup', command: 'powershell.exe' },
  { client: 'codex', operation: 'setup', path: 'C:/tmp/evil.js' },
  { client: 'codex', operation: 'setup', token: 'zc_agent_secret' },
  { client: 'codex', operation: 'shell' },
  { client: 'codex', operation: 'authorize', scopes: ['admin:all'] },
  { client: 'codex', operation: 'authorize', verification_url: 'https://evil.example' },
]) {
  assert.throws(
    () => validateDesktopAgentIntegrationRequest(unsafe),
    /不接受命令|允许列表/,
  );
}
for (const operation of ['authorize', 'cancel_authorization']) {
  const authorization_id = randomUUID();
  assert.deepEqual(validateDesktopAgentIntegrationRequest({ client: 'codex', operation, authorization_id }), { client: 'codex', operation, authorization_id });
  for (const id of [undefined, '', 'previous-flow', '../escape', 4]) {
    assert.throws(() => validateDesktopAgentIntegrationRequest({ client: 'codex', operation, authorization_id: id }), /UUID/);
  }
}
assert.throws(() => validateDesktopAgentIntegrationRequest({ client: 'codex', operation: 'setup', authorization_id: randomUUID() }), /不接受授权批次/);

const hash = desktopUserHash('user_profile_123');
assert.match(hash, /^[a-f0-9]{64}$/u);
assert.equal(localPlatformLockKey('user_profile_123', 'douyin'), `${hash}:douyin`);
assert.equal(
  platformSessionPath('D:/sessions', 'user_profile_123', 'douyin'),
  join('D:/sessions', hash, 'douyin'),
);
assert.equal(
  normalizeLocalPlatformResult('douyin', {
    success: false,
    error: '失败 C:/Users/demo/private.json token=secret-value',
  }).error,
  '失败 [本机路径] token=[已隐藏]',
);

const temporary = await mkdtemp(join(tmpdir(), 'zhicui-agent-integration-'));
try {
  const locks = new CrossProcessActionLock(() => join(temporary, 'locks'));
  const first = await locks.acquire('same-user:douyin');
  await assert.rejects(
    () => locks.acquire('same-user:douyin'),
    (error) => error instanceof LocalActionBusyError && error.code === 'LOCAL_ACTION_BUSY',
  );
  await first.release();
  const second = await locks.acquire('same-user:douyin');
  await second.release();

  const fakeCli = join(temporary, 'fake-cli.cjs');
  const fakeState = join(temporary, 'fake-state.json');
  const fakeCalls = join(temporary, 'fake-calls.jsonl');
  const initialState = { configured: false, authenticated: false, cloud_available: true, mcp_healthy: true, auth_mode: 'success' };
  await writeFile(fakeState, JSON.stringify(initialState));
  await writeFile(fakeCli, [
    "const fs = require('node:fs');",
    `const statePath = ${JSON.stringify(fakeState)};`,
    `const callsPath = ${JSON.stringify(fakeCalls)};`,
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(callsPath, JSON.stringify(args) + '\\n');",
    "const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));",
    "if (process.env.ZHICUI_CLI_EXECUTABLE) throw new Error('桌面不得继承替代 CLI 入口');",
    "const save = () => fs.writeFileSync(statePath, JSON.stringify(state));",
    "const client = args[args.indexOf('--client') + 1] || 'codex';",
    "const operation = args[1] || 'status';",
    "const write = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
    "if (args[0] === 'auth') {",
    "  write({event:'device_authorization',status:'waiting_for_user',user_code:'TEST-1234',expires_at:'2099-01-01T00:00:00Z',verification_url:'https://luxai.cn/agent-access',device_code:'SHOULD_NOT_LEAVE_PROCESS',access_token:'FAKE_SECRET_ACCESS',terminal:false});",
    "  setTimeout(() => {",
    "    if (state.auth_mode === 'error') { write({event:'error',status:'failed',error:{code:'INTERFACE_DISABLED',message:'Agent 接口尚未启用 device_code=FAKE_SECRET_DEVICE'},terminal:true}); process.exitCode=7; return; }",
    "    state.authenticated=true; save();",
    "    write({event:'authorization_complete',status:'succeeded',authenticated:true,kind:'device',scopes:['account:read'],terminal:true});",
    "  }, state.auth_mode === 'hold' ? 10000 : 30);",
    "} else if (operation === 'doctor') {",
    "  const checks = (client === 'all' ? ['codex','claude'] : [client]).map((name) => ({client:name,installed:true,configured:state.configured,managed:state.configured,skill_current:state.configured,authenticated:state.authenticated,cloud_available:state.cloud_available,mcp_healthy:state.mcp_healthy,ready:state.configured&&state.authenticated&&state.cloud_available&&state.mcp_healthy,version:'test',code:state.code}));",
    "  write({ok:true,checks,credential:{authenticated:state.authenticated},cloud:{available:state.cloud_available},local:{available:false,account_binding_verified:false}});",
    "} else {",
    "  if (operation === 'setup' || operation === 'update') state.configured=true;",
    "  if (operation === 'uninstall') state.configured=false;",
    "  save();",
    "  write({[client]:{installed:true,configured:state.configured,managed:state.configured,skill_current:state.configured,version:'test',changed:true,message:operation+' ok'}});",
    "}",
  ].join('\n'), 'utf8');
  const authorizationEvents = [];
  const integration = new DesktopAgentIntegration(() => fakeCli, process.execPath, (status) => authorizationEvents.push(status));
  const previousCliOverride = process.env.ZHICUI_CLI_EXECUTABLE;
  process.env.ZHICUI_CLI_EXECUTABLE = 'C:/retired-acceptance/cli.exe';
  try { assert.equal((await integration.status()).clients[0].installed, true); }
  finally {
    if (previousCliOverride === undefined) delete process.env.ZHICUI_CLI_EXECUTABLE;
    else process.env.ZHICUI_CLI_EXECUTABLE = previousCliOverride;
  }
  for (const operation of ['setup', 'setup', 'uninstall', 'uninstall']) {
    const result = await integration.run({ client: 'codex', operation });
    assert.equal(result.success, true);
    assert.equal(result.installed, true);
    assert.equal(result.configured, operation !== 'uninstall');
    assert.equal(result.ready, false, '配置成功不能冒充已授权可调用');
  }
  const overview = await integration.status();
  assert.equal(overview.capabilities.version, 2);
  assert.equal(overview.capabilities.supports_authorization, true);
  assert.match(overview.setup_prompt, /ELECTRON_RUN_AS_NODE/);
  assert.ok(overview.setup_prompt.includes(JSON.stringify(fakeCli).slice(1, -1)));
  assert.doesNotMatch(overview.setup_prompt, /npx|acceptance|npm install/);
  assert.match(overview.setup_prompt, /重新加载|不会热替换/);
  assert.equal((await integration.run({ client: 'codex', operation: 'authorize', authorization_id: randomUUID() })).code, 'DESKTOP_AUTH_REQUIRED');
  await integration.run({ client: 'codex', operation: 'setup' });
  integration.bindUser('fixture-owner-A');
  const completedId = randomUUID();
  const authorized = await integration.run({ client: 'codex', operation: 'authorize', authorization_id: completedId });
  assert.equal(authorized.success, true);
  assert.equal(authorized.authenticated, true);
  assert.equal(authorized.ready, true);
  assert.equal((await integration.status()).authorization, undefined, '已完成授权不重放旧设备码');
  assert.deepEqual(authorizationEvents.map((event) => event.status), ['starting', 'waiting', 'success']);
  assert.equal(authorizationEvents[1].user_code, 'TEST-1234');
  assert.ok(authorizationEvents.every((event) => event.authorization_id === completedId));
  assert.doesNotMatch(JSON.stringify(authorizationEvents), /SHOULD_NOT|FAKE_SECRET|device_code|access_token|verification_url/);
  await writeFile(fakeState, JSON.stringify({ ...initialState, configured: true, authenticated: true, cloud_available: false }));
  const cloudClosed = await integration.status();
  assert.equal(cloudClosed.clients[0].configured, true);
  assert.equal(cloudClosed.clients[0].authenticated, true);
  assert.equal(cloudClosed.clients[0].cloud_available, false);
  assert.equal(cloudClosed.clients[0].ready, false);
  assert.equal(cloudClosed.clients[0].code, 'CLOUD_UNAVAILABLE');
  await writeFile(fakeState, JSON.stringify({ ...initialState, configured: true, authenticated: false, cloud_available: false, code: 'INTERFACE_DISABLED' }));
  assert.equal((await integration.status()).clients[0].code, 'INTERFACE_DISABLED', '云端关闭导致授权无法验证时，不应诱导用户重复授权');
  await writeFile(fakeState, JSON.stringify({ ...initialState, configured: true, authenticated: true, mcp_healthy: false }));
  assert.equal((await integration.status()).clients[0].code, 'MCP_UNAVAILABLE');
  await writeFile(fakeState, JSON.stringify({ ...initialState, configured: true, authenticated: true, code: 'AGENT_UPDATE_REQUIRED' }));
  const migratedStatus = (await integration.status()).clients[0];
  assert.equal(migratedStatus.code, 'AGENT_UPDATE_REQUIRED', 'Skill 内容相同但 MCP 入口仍是旧安装目录时，保留 CLI 的迁移提示');
  assert.equal(migratedStatus.ready, false, '迁移阻断码不能同时报告 ready');

  // 授权只终止当前派生进程；不注销、删除或覆盖原有凭据，且另一 Agent 不能取消它。
  for (const cancelBy of ['explicit', 'account-switch']) {
    await writeFile(fakeState, JSON.stringify({ ...initialState, configured: true, auth_mode: 'hold' }));
    authorizationEvents.length = 0;
    const authorization_id = randomUUID();
    const pending = integration.run({ client: 'codex', operation: 'authorize', authorization_id });
    for (let attempt = 0; attempt < 100 && !authorizationEvents.some((event) => event.status === 'waiting'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(authorizationEvents.some((event) => event.status === 'waiting'));
    assert.equal((await integration.status()).authorization?.user_code, 'TEST-1234', '页面重载可恢复等待中的公共设备码');
    assert.equal((await integration.status()).authorization?.authorization_id, authorization_id);
    assert.equal((await integration.run({ client: 'claude', operation: 'authorize', authorization_id: randomUUID() })).code, 'AUTHORIZATION_BUSY');
    assert.equal(integration.cancelAuthorization('claude', authorization_id).code, 'AUTHORIZATION_NOT_FOUND');
    assert.equal(integration.cancelAuthorization('codex', completedId).code, 'AUTHORIZATION_NOT_FOUND', '旧页面的迟到取消不能关闭同客户端的新授权');
    assert.equal(integration.cancelAuthorization('codex').code, 'AUTHORIZATION_NOT_FOUND', '网页调用不能降级为无批次全局取消');
    assert.equal((await integration.status()).authorization?.authorization_id, authorization_id);
    if (cancelBy === 'explicit') integration.cancelAuthorization('codex', authorization_id);
    else integration.bindUser('fixture-owner-B');
    assert.equal((await pending).code, 'AUTHORIZATION_CANCELLED');
    assert.equal((await integration.status()).authorization, undefined, '取消或账号切换后清空设备码');
    assert.equal(JSON.parse(await readFile(fakeState, 'utf8')).authenticated, false);
    assert.deepEqual(authorizationEvents.map((event) => event.status), ['starting', 'waiting', 'cancelled']);
  }
  await writeFile(fakeState, JSON.stringify({ ...initialState, configured: true, auth_mode: 'error' }));
  authorizationEvents.length = 0;
  const rejected = await integration.run({ client: 'codex', operation: 'authorize', authorization_id: randomUUID() });
  assert.equal(rejected.success, false);
  assert.equal(rejected.code, 'INTERFACE_DISABLED');
  assert.doesNotMatch(JSON.stringify([rejected, authorizationEvents]), /FAKE_SECRET_DEVICE/);
  await Promise.all([integration.reconcileManaged(), integration.reconcileManaged()]);
  const calls = (await readFile(fakeCalls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.filter((args) => args[1] === 'reconcile').length, 1, '重复启动检查合并，不并发修改配置');
  assert.deepEqual(calls.find((args) => args[1] === 'reconcile'), ['agent', 'reconcile', '--client', 'all', '--json', '--non-interactive']);
  assert.ok(calls.filter((args) => args[0] === 'auth').every((args) => args.includes('--no-open') && args.includes('--jsonl')));
  for (const args of calls.filter((item) => item[0] === 'auth')) {
    assert.deepEqual(args[args.indexOf('--scopes') + 1].split(','), ['library:read', 'library:write', 'ask:run', 'knowledge:read', 'knowledge:write', 'plan:read', 'plan:write', 'creator:sync', 'local:invoke']);
  }
  assert.ok(calls.every((args) => !args.includes('logout')), '取消授权不应注销已经保存的 CLI 账号');

  assert.equal(
    resolveBundledCliEntry({
      packaged: true,
      resourcesPath: 'C:/Program Files/Zhicui/resources',
      compiledDirectory: 'ignored',
    }),
    join('C:/Program Files/Zhicui/resources', 'cli', 'index.js'),
  );

  const mediaUserData = join(temporary, 'media-user-data');
  const mediaVideos = join(temporary, 'media-videos');
  const profileA = 'opaque_profile_A_123';
  const profileB = 'opaque_profile_B_456';
  const awemeId = 'owned-by-profile-a';
  const videoPath = join(mediaVideos, `${awemeId}.mp4`);
  const profileADirectory = desktopMediaProfileDirectory(mediaUserData, profileA);
  await mkdir(profileADirectory, { recursive: true });
  await mkdir(mediaVideos, { recursive: true });
  await writeFile(videoPath, 'profile-a-video', 'utf8');
  await writeFile(join(profileADirectory, 'index.json'), JSON.stringify({
    version: 1,
    assets: {
      [awemeId]: {
        awemeId,
        title: 'A 的视频',
        videoPath,
        sizeBytes: 15,
        savedAt: '2026-09-03T00:00:00.000Z',
      },
    },
  }), 'utf8');
  const revealed = [];
  const mediaLibrary = new DesktopMediaLibrary(() => undefined, {
    userDataDirectory: mediaUserData,
    videosDirectory: mediaVideos,
    openPath: async () => '',
    showItemInFolder: (path) => revealed.push(path),
  });
  mediaLibrary.bindProfile(profileA);
  assert.equal(mediaLibrary.getAsset(awemeId).status, 'cached');
  assert.equal(await mediaLibrary.reveal(awemeId), true);
  assert.deepEqual(revealed, [videoPath]);
  mediaLibrary.bindProfile(profileB);
  assert.equal(mediaLibrary.getAsset(awemeId).status, 'remote');
  assert.equal(await mediaLibrary.reveal(awemeId), false);
  assert.equal(mediaLibrary.remove(awemeId).status, 'remote');
  await access(videoPath);
  mediaLibrary.bindProfile(profileA);
  assert.equal(mediaLibrary.getAsset(awemeId).status, 'cached');
  assert.equal(mediaLibrary.remove(awemeId).status, 'remote');
  await assert.rejects(() => access(videoPath));

  const preload = await readFile(join(desktopRoot, 'src', 'preload.ts'), 'utf8');
  const main = await readFile(join(desktopRoot, 'src', 'main.ts'), 'utf8');
  const security = await readFile(join(desktopRoot, 'src', 'security.ts'), 'utf8');
  const contract = await readFile(join(desktopRoot, 'src', 'contract.ts'), 'utf8');
  const localBridge = await readFile(join(desktopRoot, 'src', 'agent-action-bridge.ts'), 'utf8');
  const packageJson = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
  assert.match(preload, /desktop:get-agent-integration-status/);
  assert.match(preload, /desktop:run-agent-integration-action/);
  assert.match(preload, /desktop:agent-authorization-status/);
  assert.match(main, /if \(app\.isPackaged\) void agentIntegration\.reconcileManaged\(\)/);
  assert.match(main, /agentIntegration\.cancelAuthorization\(\)/);
  assert.match(preload, /desktop:bind-agent-user/);
  assert.match(main, /desktop:bind-agent-user/);
  assert.match(main, /session\.user\.agent_profile_key \|\| null/);
  assert.doesNotMatch(preload, /runShell|execCommand|arbitraryCommand/iu);
  assert.match(security, /key !== 'client' && key !== 'operation'/);
  assert.doesNotMatch(contract, /shell|cookie|jwt|apiKey/iu);
  assert.match(localBridge, /listen\(0, '127\.0\.0\.1'/u);
  assert.match(localBridge, /timingSafeEqual/u);
  assert.match(localBridge, /LOCAL_USER_MISMATCH/u);
  assert.match(localBridge, /desktopUserHash\(requestedProfileKey\).*desktopUserHash\(activeProfileKey\)/su);
  assert.match(localBridge, /this\.token = randomBytes\(32\)/u);
  assert.match(localBridge, /Date\.now\(\) >= this\.tokenExpiresAt/u);
  assert.match(localBridge, /MAX_REQUEST_BYTES/u);
  assert.match(localBridge, /showMessageBox/u);
  assert.match(localBridge, /ephemeralMediaUrl: _secretMediaUrl/u);
  assert.match(localBridge, /coverUrl: _temporaryCoverUrl/u);
  assert.match(localBridge, /cover_available: Boolean\(_temporaryCoverUrl\)/u);
  assert.match(localBridge, /getMediaLibrary\(\)\?\.bindProfile\(normalized \|\| null\)/u);
  assert.match(localBridge, /this\.activeUiJob = null/u);
  assert.match(localBridge, /LOCAL_MEDIA_NOT_OWNED/u);
  assert.match(localBridge, /local\.media\.directory\.choose'[\s\S]*?this\.startUiJob\(/u);
  assert.match(localBridge, /status: 'waiting_for_user'/u);
  assert.match(localBridge, /publicMediaSettings/u);
  assert.doesNotMatch(localBridge, /data: mediaLibrary!\.getSettings\(\)/u);
  const rebindBlock = localBridge.match(
    /if \(action === 'local\.platform\.rebind'\)([\s\S]*?)\n    \}\n    const mediaLibrary/u,
  )?.[1] || '';
  assert.doesNotMatch(rebindBlock, /this\.confirm\(/u);
  assert.doesNotMatch(localBridge, /execFile|spawn|powershell|cmd\.exe/iu);
  assert.ok(packageJson.build.extraResources.some((item) => item.to === 'cli'));
  assert.match(packageJson.scripts.pack, /prepare:cli/u);
  assert.match(packageJson.scripts['dist:win'], /prepare:cli/u);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log('Agent integration verification passed.');
