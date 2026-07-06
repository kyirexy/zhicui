#!/bin/bash
# 知萃 APK 构建脚本 (方案 B: 本地构建 + push 自动部署)
# 用法: bash scripts/build-apk.sh
# 可选: API_URL=https://your-domain bash scripts/build-apk.sh
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-https://luxai.cn}"

echo "=== [1/4] 静态导出前端 (API: $API_URL) ==="
cd "$ROOT/frontend"
CAPACITOR_BUILD=true NEXT_PUBLIC_API_URL="$API_URL" npx next build

echo "=== [2/4] 同步到 Android ==="
npx cap sync android

echo "=== [3/4] Gradle 构建 debug APK ==="
cd android
./gradlew assembleDebug

echo "=== [4/4] 复制 APK + git push ==="
cp app/build/outputs/apk/debug/app-debug.apk ../public/download/zhicui.apk
cd "$ROOT"
git add frontend/public/download/zhicui.apk
git commit -m "chore: rebuild APK via build-apk.sh (API: $API_URL)" || echo "⚠️ 无改动可提交"
git push gitee master

echo ""
echo "✅ APK 构建并推送完成 — Jenkins 会自动拉取部署"
echo "   下载地址: https://luxai.cn/download/zhicui.apk"
