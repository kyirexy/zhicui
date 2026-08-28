#!/usr/bin/env bash
# 知萃 Android beta/stable 构建、签名身份验证与清单原子更新。
set -Eeuo pipefail

# RELEASE_COMMIT 必须是调用方明确给出的完整提交；外层只负责创建隔离 worktree，
# 真正构建由目标提交中的本脚本执行，避免当前 checkout 的未追踪文件进入 APK。
CALLER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_COMMIT="${RELEASE_COMMIT:-}"
[[ "$RELEASE_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || {
  echo '必须显式设置 RELEASE_COMMIT=<40位 Git 提交 SHA>' >&2
  exit 1
}
RESOLVED_COMMIT="$(git -C "$CALLER_ROOT" rev-parse --verify "${RELEASE_COMMIT}^{commit}" 2>/dev/null || true)"
[[ "${RESOLVED_COMMIT,,}" == "${RELEASE_COMMIT,,}" ]] || {
  echo 'RELEASE_COMMIT 不存在或不是完整、不可变的提交 SHA' >&2
  exit 1
}

if [[ "${ZHICUI_RELEASE_WORKTREE_INTERNAL:-0}" != "1" ]]; then
  WORKTREE_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/zhicui-android-release.XXXXXX")"
  WORKTREE_DIR="$WORKTREE_PARENT/source"
  cleanup_release_worktree() {
    git -C "$CALLER_ROOT" worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || true
    rmdir "$WORKTREE_PARENT" >/dev/null 2>&1 || true
  }
  trap cleanup_release_worktree EXIT
  git -C "$CALLER_ROOT" worktree add --detach "$WORKTREE_DIR" "$RESOLVED_COMMIT"
  [[ "$(git -C "$WORKTREE_DIR" rev-parse HEAD)" == "$RESOLVED_COMMIT" ]] || {
    echo '隔离 worktree 的提交身份校验失败' >&2
    exit 1
  }
  [[ -z "$(git -C "$WORKTREE_DIR" status --porcelain=v1 --untracked-files=all)" ]] || {
    echo '新建隔离 worktree 不是干净状态' >&2
    exit 1
  }
  ZHICUI_RELEASE_WORKTREE_INTERNAL=1 \
  ZHICUI_RELEASE_CALLER_ROOT="$CALLER_ROOT" \
  RELEASE_COMMIT="$RESOLVED_COMMIT" \
    bash "$WORKTREE_DIR/scripts/build-apk.sh"
  exit $?
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CALLER_ROOT="${ZHICUI_RELEASE_CALLER_ROOT:?隔离构建缺少调用方仓库路径}"
[[ "$(git -C "$ROOT" rev-parse HEAD)" == "$RESOLVED_COMMIT" ]] || {
  echo '构建 worktree 与 RELEASE_COMMIT 不一致' >&2
  exit 1
}
[[ -z "$(git -C "$ROOT" symbolic-ref -q HEAD || true)" ]] || {
  echo 'Android 发行构建必须运行在 detached worktree' >&2
  exit 1
}
[[ -z "$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)" ]] || {
  echo '隔离 worktree 在依赖安装前已被污染' >&2
  exit 1
}
API_URL="${API_URL:-https://luxai.cn}"
CHANNEL="${RELEASE_CHANNEL:-beta}"
PUBLISH="${PUBLISH:-0}"
[[ "$CHANNEL" == "beta" || "$CHANNEL" == "stable" ]] ||
  { echo 'RELEASE_CHANNEL 只能是 beta 或 stable' >&2; exit 1; }
[[ "$PUBLISH" == "0" || "$PUBLISH" == "1" ]] ||
  { echo 'PUBLISH 只能是 0 或 1，且默认安全关闭' >&2; exit 1; }
git -C "$ROOT" diff --cached --quiet -- || {
  echo 'Git index 已有暂存内容；拒绝混入 Android 发行提交' >&2
  exit 1
}

LEGACY_MANIFEST="$ROOT/frontend/public/download/latest.json"
CHANNEL_MANIFEST="$ROOT/frontend/public/download/releases/android/$CHANNEL.json"
APK_PUBLIC_ROOT="$ROOT/frontend/public/download"

find_android_tool() {
  local tool="$1"
  local sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
  local windows_user="${USERNAME:-${USER:-}}"
  if [[ -z "$sdk" && -n "$windows_user" && -d "/c/Users/$windows_user/AppData/Local/Android/Sdk" ]]; then
    sdk="/c/Users/$windows_user/AppData/Local/Android/Sdk"
  fi
  [[ -n "$sdk" && -d "$sdk/build-tools" ]] || return 1
  find "$sdk/build-tools" -mindepth 2 -maxdepth 2 -type f \
    \( -name "$tool" -o -name "$tool.bat" -o -name "$tool.exe" \) \
    -print | sort -V | tail -n 1
}

if [[ "$CHANNEL" == "stable" ]]; then
  : "${RELEASE_VERSION:?Stable 需要 RELEASE_VERSION=x.y.z}"
  : "${RELEASE_BUILD:?Stable 需要 RELEASE_BUILD=正整数}"
  : "${ZHICUI_ANDROID_KEYSTORE_PATH:?Stable 需要 ZHICUI_ANDROID_KEYSTORE_PATH}"
  : "${ZHICUI_ANDROID_KEYSTORE_PASSWORD:?Stable 需要 ZHICUI_ANDROID_KEYSTORE_PASSWORD}"
  : "${ZHICUI_ANDROID_KEY_ALIAS:?Stable 需要 ZHICUI_ANDROID_KEY_ALIAS}"
  : "${ZHICUI_ANDROID_KEY_PASSWORD:?Stable 需要 ZHICUI_ANDROID_KEY_PASSWORD}"
  : "${ZHICUI_ANDROID_CERT_SHA256:?Stable 需要 ZHICUI_ANDROID_CERT_SHA256}"
  VERSION="$RELEASE_VERSION"
  BUILD="$RELEASE_BUILD"
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    { echo 'RELEASE_VERSION 格式无效' >&2; exit 1; }
  [[ "$BUILD" =~ ^[1-9][0-9]*$ ]] ||
    { echo 'RELEASE_BUILD 必须是正整数' >&2; exit 1; }
else
  readarray -t RELEASE_IDENTITY < <(node - "$LEGACY_MANIFEST" <<'NODE'
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '') || !Number.isInteger(manifest.build)) {
  throw new Error('latest.json 缺少有效 beta 版本/构建号');
}
console.log(manifest.version);
console.log(manifest.build);
NODE
  )
  VERSION="${RELEASE_IDENTITY[0]}"
  BUILD="${RELEASE_IDENTITY[1]}"
fi

echo "=== [1/6] 构建 Android $CHANNEL $VERSION ($BUILD) ==="
cd "$ROOT/frontend"
npm ci --silent
CAPACITOR_BUILD=true \
NEXT_PUBLIC_API_URL="$API_URL" \
NEXT_PUBLIC_RELEASE_CHANNEL="$CHANNEL" \
npm run build
npx cap sync android
# public/download 是站点发行目录，不能递归嵌入 APK 自身。
find "$ROOT/frontend/android/app/src/main/assets/public/download" -type f -name '*.apk' -delete 2>/dev/null || true

echo "=== [2/6] Gradle 生成目标 APK ==="
cd "$ROOT/frontend/android"
export ZHICUI_ANDROID_VERSION="$VERSION"
export ZHICUI_ANDROID_BUILD="$BUILD"
if [[ "$CHANNEL" == "stable" ]]; then
  ./gradlew assembleRelease
  BUILT_APK="$ROOT/frontend/android/app/build/outputs/apk/release/app-release.apk"
else
  ./gradlew assembleDebug
  BUILT_APK="$ROOT/frontend/android/app/build/outputs/apk/debug/app-debug.apk"
fi
[[ -s "$BUILT_APK" ]] || { echo "APK 产物缺失：$BUILT_APK" >&2; exit 1; }

echo "=== [3/6] 验证 APK 签名、身份与 debuggable ==="
APKSIGNER="$(find_android_tool apksigner)" ||
  { echo '找不到 Android SDK apksigner，拒绝发布' >&2; exit 1; }
AAPT="$(find_android_tool aapt)" ||
  { echo '找不到 Android SDK aapt，拒绝发布' >&2; exit 1; }
SIGN_OUTPUT="$("$APKSIGNER" verify --verbose --print-certs "$BUILT_APK" | tr -d '\r')"
printf '%s\n' "$SIGN_OUTPUT" | grep -q '^Verifies$' ||
  { echo 'apksigner 验证失败' >&2; exit 1; }
CERT_SHA256="$(printf '%s\n' "$SIGN_OUTPUT" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | head -n1 | tr '[:upper:]' '[:lower:]')"
[[ "$CERT_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo '无法读取 APK 证书 SHA-256' >&2; exit 1; }
BADGING="$("$AAPT" dump badging "$BUILT_APK")"
PACKAGE_LINE="$(printf '%s\n' "$BADGING" | grep '^package:' | head -n1)"
printf '%s\n' "$PACKAGE_LINE" | grep -q "name='com.videocapsule.app'" ||
  { echo 'APK applicationId 不匹配' >&2; exit 1; }
printf '%s\n' "$PACKAGE_LINE" | grep -q "versionCode='$BUILD'" ||
  { echo 'APK versionCode 与清单不一致' >&2; exit 1; }
printf '%s\n' "$PACKAGE_LINE" | grep -q "versionName='$VERSION'" ||
  { echo 'APK versionName 与清单不一致' >&2; exit 1; }
if [[ "$CHANNEL" == "stable" ]]; then
  if printf '%s\n' "$BADGING" | grep -q '^application-debuggable'; then
    echo 'Stable APK 被标记为 debuggable，拒绝发布' >&2
    exit 1
  fi
  EXPECTED_CERT="$(printf '%s' "$ZHICUI_ANDROID_CERT_SHA256" | tr -d ':[:space:]' | tr '[:upper:]' '[:lower:]')"
  [[ "$CERT_SHA256" == "$EXPECTED_CERT" ]] ||
    { echo 'Stable APK 证书指纹与允许身份不一致' >&2; exit 1; }
  ARTIFACT_KIND='release'
  DEBUGGABLE='false'
else
  printf '%s\n' "$BADGING" | grep -q '^application-debuggable' ||
    { echo 'Beta Debug APK 未标记 debuggable，构建类型异常' >&2; exit 1; }
  ARTIFACT_KIND='debug'
  DEBUGGABLE='true'
fi

echo "=== [4/6] 复制版本化产物并生成清单 ==="
if [[ "$CHANNEL" == "stable" ]]; then
  mkdir -p "$APK_PUBLIC_ROOT/android"
  TARGET_APK="$APK_PUBLIC_ROOT/android/Zhicui-$VERSION-$BUILD.apk"
  DOWNLOAD_URL="https://luxai.cn/download/android/Zhicui-$VERSION-$BUILD.apk"
else
  TARGET_APK="$APK_PUBLIC_ROOT/zhicui.apk"
  DOWNLOAD_URL='https://luxai.cn/download/zhicui.apk'
fi
cp "$BUILT_APK" "$TARGET_APK"
SIZE_BYTES="$(wc -c <"$TARGET_APK" | tr -d '[:space:]')"
SHA256="$(sha256sum "$TARGET_APK" | awk '{print tolower($1)}')"
PUBLISHED_AT="$(node -e 'console.log(new Date().toISOString())')"
if [[ -z "${RELEASE_NOTES_JSON:-}" ]]; then
  RELEASE_NOTES_JSON='["改进客户端稳定性与安全更新体验。"]'
fi

node - "$CHANNEL_MANIFEST" "$CHANNEL" "$VERSION" "$BUILD" "$DOWNLOAD_URL" "$SIZE_BYTES" "$SHA256" "$CERT_SHA256" "$ARTIFACT_KIND" "$DEBUGGABLE" "$PUBLISHED_AT" "$RELEASE_NOTES_JSON" "$RESOLVED_COMMIT" <<'NODE'
const fs = require('fs');
const [path, channel, version, build, downloadUrl, size, sha256, cert, kind, debuggable, publishedAt, notesJson, sourceCommit] = process.argv.slice(2);
const notes = JSON.parse(notesJson);
if (!Array.isArray(notes) || notes.length < 1 || !notes.every(value => typeof value === 'string' && value.trim())) {
  throw new Error('RELEASE_NOTES_JSON 必须是至少含一项的 JSON 字符串数组');
}
const manifest = {
  schema_version: 2,
  channel,
  availability: 'available',
  platform: 'android',
  artifact_kind: kind,
  version,
  build: Number(build),
  published_at: publishedAt,
  source_commit: sourceCommit,
  download_url: downloadUrl,
  size_bytes: Number(size),
  sha256,
  mandatory: false,
  debuggable: debuggable === 'true',
  signing: {
    verified: true,
    identity: channel === 'stable' ? 'configured-release-keystore' : 'Android Debug',
    certificate_sha256: cert,
  },
  release_notes: notes.map(value => value.trim()),
};
fs.mkdirSync(require('path').dirname(path), { recursive: true });
const temporary = `${path}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
fs.renameSync(temporary, path);
NODE

if [[ "$CHANNEL" == "beta" ]]; then
  node - "$CHANNEL_MANIFEST" "$LEGACY_MANIFEST" <<'NODE'
const fs = require('fs');
const [channelPath, legacyPath] = process.argv.slice(2);
const current = JSON.parse(fs.readFileSync(channelPath, 'utf8'));
const legacy = {
  schema_version: 1,
  ...current,
};
const temporary = `${legacyPath}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
fs.renameSync(temporary, legacyPath);
NODE
fi

echo "=== [5/6] 验证四份渠道清单 ==="
cd "$ROOT"
node scripts/verify-release-manifests.mjs

echo "=== [6/6] 记录发行物 ==="
if [[ "$PUBLISH" == "1" ]]; then
  allowed_paths=(
    "${CHANNEL_MANIFEST#"$ROOT/"}"
    "${TARGET_APK#"$ROOT/"}"
  )
  if [[ "$CHANNEL" == "beta" ]]; then
    allowed_paths+=("${LEGACY_MANIFEST#"$ROOT/"}")
  fi
  while IFS= read -r dirty_path; do
    [[ -z "$dirty_path" ]] && continue
    allowed=0
    for candidate in "${allowed_paths[@]}"; do
      [[ "$dirty_path" == "$candidate" ]] && allowed=1
    done
    [[ "$allowed" -eq 1 ]] || {
      echo "发现与 Android 发行无关的已跟踪改动，拒绝发布：$dirty_path" >&2
      exit 1
    }
  done < <(git -C "$ROOT" status --porcelain=v1 --untracked-files=all | sed 's/^...//')
  git -C "$ROOT" add -- "${allowed_paths[@]}"
  while IFS= read -r staged_path; do
    [[ -z "$staged_path" ]] && continue
    allowed=0
    for candidate in "${allowed_paths[@]}"; do
      [[ "$staged_path" == "$candidate" ]] && allowed=1
    done
    [[ "$allowed" -eq 1 ]] || {
      echo "暂存区混入未批准文件：$staged_path" >&2
      exit 1
    }
  done < <(git -C "$ROOT" diff --cached --name-only --)
  git -C "$ROOT" diff --cached --quiet -- && {
    echo '没有新的 Android 发行改动，拒绝创建空提交' >&2
    exit 1
  }
  REMOTE_MASTER="$(git -C "$ROOT" ls-remote --exit-code gitee refs/heads/master | awk 'NR == 1 {print $1}')"
  [[ "$REMOTE_MASTER" == "$RESOLVED_COMMIT" ]] || {
    echo "Gitee master 已偏离指定源提交，拒绝发布：$REMOTE_MASTER" >&2
    exit 1
  }
  git -C "$ROOT" commit -m "chore: build Android $CHANNEL $VERSION ($BUILD)"
  ARTIFACT_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
  git -C "$ROOT" push gitee "$ARTIFACT_COMMIT:refs/heads/master"
  echo "已推送发行提交 $ARTIFACT_COMMIT（源提交 $RESOLVED_COMMIT），Jenkins 会部署经过验证的清单和产物。"
else
  copy_release_output() {
    local source_file="$1" relative_path="$2"
    local destination="$CALLER_ROOT/$relative_path" temporary="$CALLER_ROOT/$relative_path.tmp-$$"
    mkdir -p "$(dirname "$destination")"
    cp "$source_file" "$temporary"
    mv -f "$temporary" "$destination"
  }
  copy_release_output "$CHANNEL_MANIFEST" "${CHANNEL_MANIFEST#"$ROOT/"}"
  copy_release_output "$TARGET_APK" "${TARGET_APK#"$ROOT/"}"
  if [[ "$CHANNEL" == "beta" ]]; then
    copy_release_output "$LEGACY_MANIFEST" "${LEGACY_MANIFEST#"$ROOT/"}"
  fi
  echo "PUBLISH=0：已从源提交 $RESOLVED_COMMIT 完成隔离构建，产物已复制回调用仓库；未暂存、提交或推送。"
fi
echo "Android $CHANNEL 完成：$TARGET_APK"
echo "SHA-256：$SHA256"
