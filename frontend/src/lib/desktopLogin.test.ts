import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildDesktopLoginApprovalUrl,
  parseDesktopLoginQr,
} from './desktopLogin.ts';

const sessionId = `dls-${'a'.repeat(32)}`;
const approvalToken = 'b'.repeat(43);
const approvalUrl = `https://luxai.cn/login#desktop-login=${sessionId}.${approvalToken}`;
const testDirectory = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(testDirectory, '..');
const read = (path: string) => readFileSync(resolve(srcRoot, path), 'utf8');

test('只解析可信来源、固定路径和 fragment 中的桌面登录凭证', () => {
  assert.deepEqual(parseDesktopLoginQr(approvalUrl), {
    sessionId,
    approvalToken,
  });

  for (const value of [
    `https://evil.example/login#desktop-login=${sessionId}.${approvalToken}`,
    `https://luxai.cn/settings#desktop-login=${sessionId}.${approvalToken}`,
    `https://luxai.cn/login?desktop-login=${sessionId}.${approvalToken}`,
    `https://luxai.cn/login?from=qr#desktop-login=${sessionId}.${approvalToken}`,
    `https://luxai.cn/login#desktop-login=${sessionId}.${approvalToken}.extra`,
    `https://luxai.cn/login#desktop-login=${sessionId}.short`,
  ]) {
    assert.equal(parseDesktopLoginQr(value), null, value);
  }
});

test('本地联调来源必须显式加入白名单', () => {
  const localUrl = `http://localhost:3000/login#desktop-login=${sessionId}.${approvalToken}`;
  assert.equal(parseDesktopLoginQr(localUrl), null);
  assert.deepEqual(parseDesktopLoginQr(localUrl, {
    allowedOrigins: ['http://localhost:3000'],
  }), {
    sessionId,
    approvalToken,
  });
});

test('服务端审批地址与独立凭证一致时原样用于二维码', () => {
  assert.equal(buildDesktopLoginApprovalUrl({
    session_id: sessionId,
    approval_token: approvalToken,
    approval_url: approvalUrl,
  }), approvalUrl);
});

test('Android 登录页与设置页都提供原生 QR 扫码且不使用 body portal', () => {
  const scanner = read('components/MobileDesktopLoginScanner.tsx');
  const login = read('app/login/page.tsx');
  const settings = read('app/settings/page.tsx');
  const manifest = readFileSync(
    resolve(srcRoot, '../android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );

  assert.match(scanner, /BarcodeFormat\.QrCode/);
  assert.match(scanner, /BarcodeScanner\.stopScan/);
  assert.match(scanner, /scanGenerationRef/);
  assert.doesNotMatch(scanner, /createPortal|appendChild|removeChild|replaceChild|document\.body\.remove/);
  assert.match(login, /label="扫描电脑登录码"/);
  assert.match(settings, /variant="settings"/);
  assert.match(manifest, /android\.permission\.CAMERA/);
  assert.match(manifest, /android\.hardware\.camera\.any/);
});
