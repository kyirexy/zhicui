import assert from 'node:assert/strict';
import test from 'node:test';
import { iosReleaseConfig } from './ios-release-config.mjs';

test('默认只生成真机 Release 归档，不导出分发包', () => {
  const result = iosReleaseConfig({ version: '1.1.10', buildNumber: '12' });
  assert.ok(result.archiveArgs.includes('iphoneos'));
  assert.ok(result.archiveArgs.includes('Release'));
  assert.ok(result.archiveArgs.includes('CODE_SIGNING_ALLOWED=NO'));
  assert.ok(result.archiveArgs.includes('CURRENT_PROJECT_VERSION=12'));
  assert.equal(result.exportOptions, null);
});

test('签名必须显式开启且具备有效团队，导出不自动上传', () => {
  assert.throws(() => iosReleaseConfig({ version: '1.1.10', buildNumber: 12, signed: true }), /IOS_TEAM_ID/);
  const result = iosReleaseConfig({ version: '1.1.10', buildNumber: 12, signed: true, team: 'ABCDE12345' });
  assert.ok(result.archiveArgs.includes('CODE_SIGNING_ALLOWED=YES'));
  assert.match(result.exportOptions, /<key>destination<\/key><string>export<\/string>/);
  assert.match(result.exportOptions, /app-store-connect/);
  assert.doesNotMatch(result.exportOptions, /<string>upload<\/string>/);
});

test('拒绝错误版本、构建号、XML 注入和未支持渠道', () => {
  for (const bad of ['0', '-1', '1.2', '1;echo', '1234567890']) {
    assert.throws(() => iosReleaseConfig({ version: '1.1.10', buildNumber: bad }), /构建号/);
  }
  assert.throws(() => iosReleaseConfig({ version: '1.0-beta', buildNumber: 1 }), /版本/);
  assert.throws(() => iosReleaseConfig({ version: '1.0.0', buildNumber: 1, signed: true, team: '<bad-team>' }), /IOS_TEAM_ID/);
  assert.throws(() => iosReleaseConfig({ version: '1.0.0', buildNumber: 1, method: 'enterprise' }), /渠道/);
});
