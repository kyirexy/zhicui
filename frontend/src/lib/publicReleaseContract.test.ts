import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(testDirectory, '..');
const frontendRoot = resolve(srcRoot, '..');
const read = (path: string) => readFileSync(resolve(srcRoot, path), 'utf8');

const publicRoutes = [
  'app/legal/terms/page.tsx',
  'app/legal/privacy/page.tsx',
  'app/support/page.tsx',
  'app/platform-limits/page.tsx',
] as const;

test('四个版本化法律与支持页面均存在且公开入口统一', () => {
  for (const route of publicRoutes) {
    assert.equal(existsSync(resolve(srcRoot, route)), true, `${route} 缺失`);
    const source = read(route);
    assert.match(source, /CURRENT_LEGAL_VERSIONS/);
    assert.match(source, /<PublicDocumentPage/);
  }

  const versions = read('lib/legalDocuments.ts');
  assert.match(versions, /LEGAL_EFFECTIVE_DATE\s*=\s*'2026 年 8 月 28 日'/);

  const policy = read('lib/clientAuthPolicy.ts');
  for (const path of ['/legal/terms', '/legal/privacy', '/support', '/platform-limits']) {
    assert.ok(policy.includes(`'${path}'`), `${path} 未加入跨端公开路由`);
  }

  const footer = read('components/AppFooter.tsx');
  assert.match(footer, /PUBLIC_INFORMATION_LINKS/);
  const settings = read('components/AccountDataSettingsCard.tsx');
  assert.match(settings, /PUBLIC_INFORMATION_LINKS/);
});

test('注册必须由用户主动勾选当前协议版本', () => {
  const login = read('app/login/page.tsx');
  const authContext = read('lib/hooks/AuthContext.tsx');
  const versions = read('lib/legalDocuments.ts');
  assert.match(login, /useState\(false\)/);
  assert.match(login, /legalAccepted/);
  assert.match(login, /type="checkbox"/);
  assert.match(login, /请先阅读并同意《用户协议》和《隐私政策》/);
  assert.match(authContext, /accepted_terms:\s*true/);
  assert.match(authContext, /accepted_privacy:\s*true/);
  assert.match(authContext, /terms_version:\s*consent\.termsVersion/);
  assert.match(authContext, /privacy_version:\s*consent\.privacyVersion/);
  assert.match(authContext, /client_type:\s*currentClientType\(\)/);
  assert.match(versions, /terms:\s*'2026-08-28'/);
  assert.match(versions, /privacy:\s*'2026-09-04'/);
});

test('账号设置提供密码重验导出和一次性不可逆注销', () => {
  const card = read('components/AccountDataSettingsCard.tsx');
  const api = read('lib/api.ts');
  assert.match(card, /downloadPersonalDataArchive/);
  assert.match(card, /prepareAccountDeletion/);
  assert.match(card, /confirmAccountDeletion/);
  assert.match(card, /type="password"/);
  assert.match(card, /deletePreparation\.impact\.map/);
  assert.match(card, /confirmation_phrase/);
  assert.match(card, /<NativeModal/);
  assert.doesNotMatch(card, /createPortal|appendChild|removeChild|replaceChild|\.remove\(\)/);
  assert.match(api, /\/api\/account\/data-export/);
  assert.match(api, /\/api\/account\/deletion\/prepare/);
  assert.match(api, /\/api\/account\/deletion\/confirm/);
});

test('窄屏与无障碍基线包含 320/390 约束、44px 操作和安全区', () => {
  const landingCss = read('components/WebLandingPage.module.css');
  const headerCss = read('components/MarketingHeader.module.css');
  const creatorCss = read('app/library/creators/CreatorLibrary.module.css');
  const footerCss = read('components/MarketingFooter.module.css');
  const accountCss = read('components/AccountDataSettingsCard.module.css');
  const modalCss = read('components/NativeModal.module.css');
  const documentCss = read('components/PublicDocumentPage.module.css');

  assert.match(landingCss, /@media \(max-width:\s*390px\)/);
  assert.match(landingCss, /max-width:\s*100vw/);
  assert.match(landingCss, /\.primaryAction,[\s\S]*?\.secondaryAction[\s\S]*?min-height:\s*4\.25rem/);
  assert.match(headerCss, /min-width:\s*0/);
  assert.match(headerCss, /@media \(max-width:\s*22rem\)[\s\S]*?\.brand\s*\{[\s\S]*?min-width:\s*2\.75rem/);
  assert.match(headerCss, /@media \(max-width:\s*22rem\)[\s\S]*?\.adminLink\s*\{[\s\S]*?min-width:\s*2\.75rem/);
  assert.match(creatorCss, /@media \(max-width:\s*520px\)[\s\S]*?\.removeButton\s*\{[\s\S]*?min-width:\s*44px/);
  assert.match(footerCss, /env\(safe-area-inset-bottom/);
  assert.match(accountCss, /min-height:\s*44px/);
  assert.match(modalCss, /width:\s*44px;[\s\S]*?height:\s*44px/);
  assert.match(modalCss, /safe-area-inset-bottom/);
  assert.match(documentCss, /min-height:\s*44px/);
  assert.match(documentCss, /safe-area-inset-(right|left|bottom)/);

  for (const css of [landingCss, headerCss, footerCss, accountCss, modalCss, documentCss]) {
    const slowDurations = [...css.matchAll(/(\d+)ms/g)]
      .map((match) => Number(match[1]))
      .filter((duration) => duration > 200);
    assert.deepEqual(slowDurations, [], '公开发布 UI 不应使用超过 200ms 的动画');
  }
});

test('robots 与 sitemap 公开必要页面并排除私有工作区', () => {
  const robots = read('app/robots.ts');
  const sitemap = read('app/sitemap.ts');
  for (const path of ['/', '/legal/terms', '/legal/privacy', '/support', '/platform-limits']) {
    assert.ok(sitemap.includes(`'https://luxai.cn${path}'`), `${path} 未进入 sitemap`);
  }
  assert.equal(sitemap.includes("'https://luxai.cn/download'"), false, '重定向页不应进入 sitemap');
  for (const path of ['/admin', '/api', '/harness', '/library', '/settings']) {
    assert.ok(robots.includes(`'${path}'`), `${path} 未从抓取中排除`);
  }
  assert.match(robots, /https:\/\/luxai\.cn\/sitemap\.xml/);
  assert.equal(existsSync(resolve(frontendRoot, 'scripts/verify-public-release-browser.mjs')), true);
});
