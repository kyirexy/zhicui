import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  isAllowedLocalAction,
  trustedLocalInputSchema,
} from '../dist/local-adapter.js';

const backendDirectory = fileURLToPath(new URL('../../backend/', import.meta.url));
const cliSourcePath = fileURLToPath(new URL('../src/local-adapter.ts', import.meta.url));
const desktopBridgePath = fileURLToPath(
  new URL('../../desktop/src/agent-action-bridge.ts', import.meta.url),
);

function loadRegistryLocalActions() {
  const source = [
    'import json',
    'from app.services.product_action_registry import registry',
    'print(json.dumps([item.descriptor().model_dump(mode="json") for item in registry.all() if item.execution_location.value == "local_windows"], ensure_ascii=False))',
  ].join(';');
  const executables = process.env.PYTHON
    ? [process.env.PYTHON]
    : (process.platform === 'win32' ? ['python'] : ['python3', 'python']);
  let lastResult;
  for (const executable of executables) {
    const result = spawnSync(executable, ['-c', source], {
      cwd: backendDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        JWT_SECRET: process.env.JWT_SECRET || 'local-contract-test-jwt-secret-32-bytes',
        PYTHONUTF8: '1',
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    lastResult = result;
    if (!result.error || result.error.code !== 'ENOENT') {
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      return JSON.parse(result.stdout);
    }
  }
  assert.fail(`无法启动 Python 读取 ProductActionRegistry：${lastResult?.error?.message || 'unknown error'}`);
}

function literalActionIds(source, declaration) {
  const declarationOffset = source.indexOf(declaration);
  assert.notEqual(declarationOffset, -1, `${declaration} 不存在`);
  const tail = source.slice(declarationOffset);
  const closingOffset = tail.indexOf(']);');
  assert.notEqual(closingOffset, -1, `${declaration} 缺少数组结尾`);
  return [...tail.slice(0, closingOffset).matchAll(/'([^']+)'/gu)]
    .map((match) => match[1])
    .sort();
}

test('all local Windows actions share one exact Registry, CLI and desktop contract', () => {
  const descriptors = loadRegistryLocalActions();
  const registryIds = descriptors.map((item) => item.id).sort();
  const cliSource = readFileSync(cliSourcePath, 'utf8');
  const desktopSource = readFileSync(desktopBridgePath, 'utf8');
  const cliIds = literalActionIds(cliSource, 'const ALLOWED_LOCAL_ACTIONS');
  const desktopIds = literalActionIds(desktopSource, 'const LOCAL_ACTIONS');

  assert.equal(registryIds.length, 18, 'Stable 本机 Action 数量发生变化，必须显式复核');
  assert.deepEqual(cliIds, registryIds, 'CLI 本机白名单与 Registry 漂移');
  assert.deepEqual(desktopIds, registryIds, '桌面桥白名单与 Registry 漂移');

  for (const descriptor of descriptors) {
    assert.equal(isAllowedLocalAction(descriptor.id), true, `${descriptor.id} 未进入 CLI 白名单`);
    assert.deepEqual(
      trustedLocalInputSchema(descriptor.id),
      descriptor.input_schema,
      `${descriptor.id} 的可信 CLI Schema 与 Registry 漂移`,
    );
    const handlerReferences = desktopSource.split(`'${descriptor.id}'`).length - 1;
    assert.ok(
      handlerReferences >= 2,
      `${descriptor.id} 只在桌面白名单出现，缺少实际处理分支`,
    );
  }
});
