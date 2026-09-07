export function iosReleaseConfig({ version, buildNumber, signed = false, team = '', method = 'app-store-connect' }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('iOS 版本必须为三段数字');
  if (!/^[1-9]\d{0,8}$/.test(String(buildNumber))) throw new Error('构建号必须为 1 至 9 位正整数');
  if (signed && !/^[A-Z0-9]{10}$/.test(team)) throw new Error('签名构建需要有效的 IOS_TEAM_ID');
  if (!['app-store-connect', 'release-testing'].includes(method)) throw new Error('不支持该导出渠道');
  return {
    version,
    buildNumber: String(buildNumber),
    signed,
    archiveArgs: [
      '-workspace', 'ios/App/App.xcworkspace', '-scheme', 'App',
      '-configuration', 'Release', '-sdk', 'iphoneos',
      '-destination', 'generic/platform=iOS',
      `MARKETING_VERSION=${version}`, `CURRENT_PROJECT_VERSION=${buildNumber}`,
      ...(signed ? ['CODE_SIGNING_ALLOWED=YES', 'CODE_SIGN_STYLE=Automatic', `DEVELOPMENT_TEAM=${team}`, '-allowProvisioningUpdates']
        : ['CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO']),
    ],
    exportOptions: signed ? `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>${method}</string>
<key>destination</key><string>export</string>
<key>signingStyle</key><string>automatic</string>
<key>teamID</key><string>${team}</string>
<key>manageAppVersionAndBuildNumber</key><false/>
<key>stripSwiftSymbols</key><true/>
</dict></plist>
` : null,
  };
}
