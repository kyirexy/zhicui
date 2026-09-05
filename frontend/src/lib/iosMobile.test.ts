import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolveClientAuthPolicy } from './clientAuthPolicy.ts';
import { detectMobileDownloadPlatform } from './mobilePlatform.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('iOS 使用已安装客户端权限，浏览器不能靠 UA 绕过', () => {
  for (const path of ['/', '/library', '/harness', '/plans', '/settings']) {
    const policy = resolveClientAuthPolicy(path, { desktop: false, nativeMobile: true, development: false });
    assert.equal(policy.installedClient, true);
    assert.equal(policy.browserClientGate, false);
    assert.equal(policy.publicRoute, false);
  }
  assert.equal(resolveClientAuthPolicy('/library', {
    desktop: false, nativeMobile: false, development: false,
  }).browserClientGate, true);
});

test('下载推荐区分 iPhone、桌面模式 iPad、安卓和 Mac', () => {
  assert.equal(detectMobileDownloadPlatform('iPhone OS 18_0', 'iPhone', 5), 'ios');
  assert.equal(detectMobileDownloadPlatform('Macintosh', 'MacIntel', 5), 'ios');
  assert.equal(detectMobileDownloadPlatform('Macintosh', 'MacIntel', 0), null);
  assert.equal(detectMobileDownloadPlatform('Android 15', 'Linux', 5), 'android');
  assert.equal(detectMobileDownloadPlatform('Windows NT 10', 'Win32'), null);
});

test('共享壳支持 iOS，安卓专用插件和 APK 更新不扩散', () => {
  for (const path of ['../app/page.tsx', '../app/login/page.tsx', '../components/AppHeader.tsx',
    '../components/AppFooter.tsx', '../components/BottomTabBar.tsx', '../components/AuthGuard.tsx']) {
    assert.match(read(path), /isNativeMobileApp/);
    assert.doesNotMatch(read(path), /isNativeAndroidApp/);
  }
  assert.match(read('./douyinNative.ts'), /\['android', 'ios'\]/);
  assert.match(read('./douyinNative.ts'), /if \(!isNativeAndroidApp\(\)\)/);
  assert.match(read('./appUpdate.ts'), /getPlatform\(\) !== 'android'/);
  assert.match(read('../components/MobileDesktopLoginScanner.tsx'), /\['android', 'ios'\]/);
});

test('iOS 相机用途、最低版本和无签名模拟器边界', () => {
  assert.match(read('../../ios/App/App/Info.plist'), /NSCameraUsageDescription/);
  assert.match(read('../../ios/App/Podfile'), /platform :ios, '15\.5'/);
  const workflow = read('../../../.github/workflows/build-ios-mobile.yml');
  assert.match(workflow, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(workflow, /iphonesimulator/);
  assert.doesNotMatch(workflow, /\.ipa|altool|upload-to-app-store/);
});

test('官网 iPhone 未发布时不伪造可下载安装包', () => {
  const page = read('../components/WebLandingPage.tsx');
  assert.match(page, /href="#download-ios"/);
  const section = page.slice(page.indexOf('<article id="download-ios"'), page.indexOf('<article id="download-mac"'));
  assert.match(section, /暂未开放下载/);
  assert.doesNotMatch(section, /href=.*\.(ipa|apk|dmg)/);
});
