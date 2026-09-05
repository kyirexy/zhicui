const { build: base } = require('./package.json');

// 正式签名必须显式启用，默认产物只用于测试。
const signed = process.env.ZHICUI_MAC_SIGNED === '1';
const arch = process.env.ZHICUI_MAC_ARCH || 'arm64';
if (!['arm64', 'x64'].includes(arch)) throw new Error('Mac 架构必须是 arm64 或 x64');
if (signed) {
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    if (!process.env[key]) throw new Error(`签名公证构建缺少 ${key}`);
  }
}

module.exports = {
  ...base,
  extends: null,
  directories: { output: `release-mac-${arch}` },
  artifactName: `Zhicui-${signed ? 'Mac' : 'Mac-Test'}-\${version}-\${arch}.\${ext}`,
  extraMetadata: { nativeUpdatesEnabled: signed },
  forceCodeSigning: signed,
  mac: {
    target: [{ target: 'dmg', arch: [arch] }, { target: 'zip', arch: [arch] }],
    category: 'public.app-category.productivity',
    icon: 'build/mac/icon.icns',
    minimumSystemVersion: '12.0',
    hardenedRuntime: signed,
    notarize: signed,
    // Apple Silicon 测试包使用临时签名，不需要开发者证书。
    ...(signed ? {} : { identity: '-' }),
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
  },
  dmg: {
    title: '知萃',
    contents: [
      { x: 130, y: 150, type: 'file' },
      { x: 410, y: 150, type: 'link', path: '/Applications' },
    ],
  },
  publish: signed ? [{
    provider: 'generic',
    url: `https://luxai.cn/download/mac/${arch}/`,
    channel: 'beta',
  }] : null,
};
