#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = new Map(
  process.argv.slice(2).map((value) => {
    const separator = value.indexOf('=');
    if (!value.startsWith('--') || separator < 3) {
      throw new Error(`参数格式无效：${value}`);
    }
    return [value.slice(2, separator), value.slice(separator + 1)];
  }),
);

function required(name) {
  const value = args.get(name);
  if (!value) throw new Error(`缺少 --${name}`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function succeeded(step, name) {
  assert(step && typeof step === 'object', `${name} 证据缺失`);
  assert(step.status === 'succeeded', `${name} 未成功`);
  return step;
}

const shaPattern = /^[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const versionPattern = /^\d+\.\d+\.\d+$/u;

function parseVersion(value, name) {
  assert(versionPattern.test(value || ''), `${name} 版本格式无效`);
  return value.split('.').map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left, '来源');
  const b = parseVersion(right, '目标');
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

const platform = required('platform');
assert(platform === 'windows' || platform === 'android', 'platform 只能是 windows 或 android');
const evidencePath = resolve(required('evidence'));
const sourceCommit = required('source-commit').toLowerCase();
const version = required('version');
const artifactSha256 = required('artifact-sha256').toLowerCase();
assert(commitPattern.test(sourceCommit), 'source-commit 必须是完整 Git SHA');
parseVersion(version, '目标');
assert(shaPattern.test(artifactSha256), 'artifact-sha256 格式无效');

const evidenceStat = await stat(evidencePath);
assert(evidenceStat.isFile(), '客户端验收证据必须是普通文件');
assert(evidenceStat.size > 0 && evidenceStat.size <= 64 * 1024, '客户端验收证据大小必须在 1 到 65536 字节之间');
const evidenceBytes = await readFile(evidencePath);
let evidence;
try {
  evidence = JSON.parse(evidenceBytes.toString('utf8'));
} catch {
  throw new Error('客户端验收证据不是有效 JSON');
}

assert(evidence?.schema_version === 1, '客户端验收证据 schema_version 必须为 1');
assert(evidence.platform === platform, '客户端验收证据平台不匹配');
assert(evidence.status === 'succeeded', '客户端验收未整体成功');
assert(evidence.source_commit === sourceCommit, '客户端验收证据提交不匹配');
assert(evidence.version === version, '客户端验收证据版本不匹配');
assert(evidence.artifact_sha256 === artifactSha256, '客户端验收证据产物 SHA-256 不匹配');
assert(shaPattern.test(evidence.device_fingerprint_sha256 || ''), '客户端验收证据缺少脱敏设备指纹');

const completedAt = Date.parse(evidence.completed_at || '');
assert(Number.isFinite(completedAt), '客户端验收证据 completed_at 无效');
const now = Date.now();
assert(completedAt <= now + 5 * 60 * 1000, '客户端验收证据完成时间位于未来');
assert(completedAt >= now - 7 * 24 * 60 * 60 * 1000, '客户端验收证据已超过 7 天');

if (platform === 'windows') {
  const freshInstall = succeeded(evidence.fresh_install, 'Windows 全新安装');
  for (const field of ['desktop_shortcut', 'start_menu_shortcut', 'login', 'bundled_cli', 'local_bridge']) {
    assert(freshInstall[field] === true, `Windows 全新安装未验证 ${field}`);
  }

  const update = succeeded(evidence.update, 'Windows 更新');
  assert(compareVersions(update.from_version, version) < 0, 'Windows 更新来源版本必须低于目标版本');
  assert(update.to_version === version, 'Windows 更新目标版本不匹配');
  for (const field of ['background_download', 'user_confirmed_install', 'session_restored']) {
    assert(update[field] === true, `Windows 更新未验证 ${field}`);
  }

  const rollback = succeeded(evidence.rollback, 'Windows 回滚恢复');
  assert(rollback.from_version === version, 'Windows 回滚来源版本不匹配');
  assert(compareVersions(rollback.to_version, version) < 0, 'Windows 回滚目标必须是更早版本');
  assert(rollback.recovery_version === version, 'Windows 回滚后未恢复到候选版本');
  assert(rollback.user_data_preserved === true, 'Windows 回滚未验证用户数据保留');
} else {
  const expectedBuild = Number(required('build'));
  const expectedCertificate = required('certificate-sha256').toLowerCase();
  assert(Number.isSafeInteger(expectedBuild) && expectedBuild > 0, 'Android build 无效');
  assert(shaPattern.test(expectedCertificate), 'Android 证书 SHA-256 无效');
  assert(evidence.build === expectedBuild, 'Android 验收证据 build 不匹配');
  assert(evidence.certificate_sha256 === expectedCertificate, 'Android 验收证据证书不匹配');

  const freshInstall = succeeded(evidence.fresh_install, 'Android 全新安装');
  assert(freshInstall.production_api_origin === 'https://luxai.cn', 'Android 全新安装未使用正式 API');
  assert(freshInstall.login === true, 'Android 全新安装未验证登录');

  const upgrade = succeeded(evidence.upgrade, 'Android 升级安装');
  assert(Number.isSafeInteger(upgrade.from_build) && upgrade.from_build > 0, 'Android 升级来源 build 无效');
  assert(upgrade.from_build < expectedBuild, 'Android 升级来源 build 必须低于目标 build');
  assert(upgrade.to_build === expectedBuild, 'Android 升级目标 build 不匹配');
  assert(upgrade.user_data_preserved === true, 'Android 升级未验证用户数据保留');
  assert(upgrade.session_restored === true, 'Android 升级未验证登录态恢复');

  const regression = succeeded(evidence.production_api_regression, 'Android 正式 API 回归');
  for (const field of ['health', 'authenticated_session', 'library', 'ask_stream']) {
    assert(regression[field] === true, `Android 正式 API 回归未验证 ${field}`);
  }
}

process.stdout.write(`${JSON.stringify({
  schema_version: 1,
  platform,
  sha256: createHash('sha256').update(evidenceBytes).digest('hex'),
  completed_at: new Date(completedAt).toISOString(),
  device_fingerprint_sha256: evidence.device_fingerprint_sha256,
})}\n`);
