import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(testDirectory, '../..');
const repositoryRoot = resolve(frontendRoot, '..');

test('Stable Windows 清单与前端解析不会回落成 Beta 元数据', () => {
  const parser = readFileSync(resolve(testDirectory, 'clientReleases.ts'), 'utf8');
  const releaseScript = readFileSync(
    resolve(repositoryRoot, 'scripts/release-desktop.ps1'),
    'utf8',
  );

  assert.match(
    releaseScript,
    /release_status\s*=\s*if\s*\(\$isStable\)\s*\{\s*'stable_download'\s*\}\s*else\s*\{\s*'beta_download'\s*\}/,
  );
  assert.match(
    parser,
    /channel === 'stable' \? 'stable_download' : 'beta_download'/,
  );
});

test('旧 Beta 手册明确退出正式发布入口', () => {
  const legacyRunbook = readFileSync(
    resolve(repositoryRoot, 'deploy/AGENT-INTERFACE-BETA.md'),
    'utf8',
  );
  assert.match(legacyRunbook, /历史灰度资料/);
  assert.match(legacyRunbook, /AGENT-INTERFACE-STABLE\.md/);
  assert.match(legacyRunbook, /不得作为新的上线步骤或验收证据/);
});
