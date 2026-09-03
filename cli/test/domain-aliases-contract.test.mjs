import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  USER_COMMAND_DOMAINS,
  domainAliasEntries,
  resolveDomainAction,
} from '../dist/domain-aliases.js';

const backendDirectory = fileURLToPath(new URL('../../backend/', import.meta.url));

function loadRegistryActions() {
  const source = [
    'import json',
    'from app.services.product_action_registry import registry',
    'print(json.dumps([item.descriptor().model_dump(mode="json") for item in registry.all()], ensure_ascii=False))',
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
        JWT_SECRET: process.env.JWT_SECRET || 'cli-contract-test-jwt-secret-32-bytes',
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

test('all user-visible domain aliases match the Stable ProductActionRegistry contract', () => {
  const actions = loadRegistryActions();
  const capabilities = { api_version: 'v1', actions };
  const knownDomains = new Set(USER_COMMAND_DOMAINS);

  for (const [command, declaredAlias] of domainAliasEntries()) {
    const [domain, ...verbParts] = command.split('.');
    const verb = verbParts.join('.');
    assert.ok(knownDomains.has(domain), `${command}: domain is not user-visible`);

    const { action, alias } = resolveDomainAction(capabilities, domain, verb);
    assert.equal(
      action.id,
      declaredAlias.candidates[0],
      `${command}: first candidate must be the current canonical Action ID`,
    );
    assert.deepEqual(alias, declaredAlias, `${command}: resolver returned a different alias`);

    const schema = action.input_schema || {};
    const properties = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const positionalKeys = declaredAlias.positionalKeys || [];
    const namedInputKeys = declaredAlias.namedInputKeys || [];
    const declaredInputs = [...positionalKeys, ...namedInputKeys];

    assert.equal(
      new Set(positionalKeys).size,
      positionalKeys.length,
      `${command}: positional keys contain duplicates`,
    );
    assert.equal(
      new Set(declaredInputs).size,
      declaredInputs.length,
      `${command}: an input key cannot be both positional and named`,
    );
    for (const key of declaredInputs) {
      assert.ok(
        Object.hasOwn(properties, key),
        `${command}: ${key} is not present in ${action.id} input_schema`,
      );
    }

    const covered = new Set(declaredInputs);
    const missing = required.filter((key) => !covered.has(key));
    assert.deepEqual(
      missing,
      [],
      `${command}: required fields need positionalKeys or explicit namedInputKeys`,
    );
  }
});
