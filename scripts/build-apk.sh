#!/bin/bash
# 知萃 APK 构建脚本 (方案 B: 本地构建 + push 自动部署)
# 用法: bash scripts/build-apk.sh
# 可选: API_URL=https://your-domain bash scripts/build-apk.sh
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-https://luxai.cn}"
RELEASE_MANIFEST="$ROOT/frontend/public/download/latest.json"

echo "=== [1/5] 校验 Android 版本清单 ==="
node - "$RELEASE_MANIFEST" <<'NODE'
const fs = require('fs');
const manifestPath = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const validVersion = typeof manifest.version === 'string'
  && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version);
const validBuild = Number.isInteger(manifest.build) && manifest.build > 0;
const validNotes = Array.isArray(manifest.release_notes)
  && manifest.release_notes.length > 0
  && manifest.release_notes.every((note) => typeof note === 'string' && note.trim().length > 0);
let validUrl = false;
try {
  const url = new URL(manifest.download_url);
  validUrl = url.protocol === 'https:'
    && url.hostname === 'luxai.cn'
    && url.pathname === '/download/zhicui.apk';
} catch {}
if (manifest.platform !== 'android' || !validVersion || !validBuild || !validNotes || !validUrl) {
  throw new Error('latest.json 缺少有效的 Android 版本、构建号、更新日志或安全下载地址');
}
console.log(`Android ${manifest.version} (${manifest.build}) · ${manifest.release_notes.length} 条更新日志`);
NODE

echo "=== [2/5] 静态导出前端 (API: $API_URL) ==="
cd "$ROOT/frontend"
CAPACITOR_BUILD=true NEXT_PUBLIC_API_URL="$API_URL" npx next build

echo "=== [3/5] 同步到 Android ==="
npx cap sync android

echo "=== [4/5] Gradle 构建 debug APK ==="
cd android
./gradlew assembleDebug

echo "=== [5/5] 复制 APK、刷新版本清单并 git push ==="
cp app/build/outputs/apk/debug/app-debug.apk ../public/download/zhicui.apk
node - "$RELEASE_MANIFEST" "$ROOT/frontend/public/download/zhicui.apk" <<'NODE'
const fs = require('fs');
const [manifestPath, apkPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.published_at = new Date().toISOString();
manifest.size_bytes = fs.statSync(apkPath).size;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`APK ${manifest.size_bytes} bytes · published_at ${manifest.published_at}`);
NODE
cd "$ROOT"
git add frontend/public/download/zhicui.apk frontend/public/download/latest.json
git commit -m "chore: rebuild APK via build-apk.sh (API: $API_URL)" || echo "⚠️ 无改动可提交"
git push gitee master

echo ""
echo "✅ APK 构建并推送完成 — Jenkins 会自动拉取部署"
echo "   下载地址: https://luxai.cn/download/zhicui.apk"
