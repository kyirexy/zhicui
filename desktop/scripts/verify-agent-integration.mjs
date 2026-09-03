import assert from 'node:assert/strict';
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
]) {
  assert.throws(
    () => validateDesktopAgentIntegrationRequest(unsafe),
    /不接受命令|允许列表/,
  );
}

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
  await writeFile(fakeCli, [
    "const args = process.argv.slice(2);",
    "const client = args[args.indexOf('--client') + 1] || 'codex';",
    "const operation = args[1] || 'status';",
    "const configured = operation !== 'uninstall';",
    "process.stdout.write(JSON.stringify({ [client]: { installed: true, configured, version: 'test', changed: true, message: operation + ' ok' } }) + '\\n');",
  ].join('\n'), 'utf8');
  const integration = new DesktopAgentIntegration(() => fakeCli, process.execPath);
  for (const operation of ['setup', 'setup', 'uninstall', 'uninstall']) {
    const result = await integration.run({ client: 'codex', operation });
    assert.equal(result.success, true);
    assert.equal(result.installed, true);
    assert.equal(result.configured, operation !== 'uninstall');
  }

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
