[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,

    [string[]]$ReleaseNotes = @(
        '支持后台下载桌面端更新，并在左下角显示实时进度。',
        '下载完成后可一键重启并安装，新版会自动回到知萃。',
        '网页功能更新与原生客户端更新采用独立、安全的发布通道。'
    ),

    [string]$Server = 'ubuntu@124.223.193.227',
    [string]$RemoteDownloadRoot = '/opt/zhicui/frontend/public/download',
    [switch]$Publish,
    [switch]$SkipBuild,
    [switch]$AllowUnsigned
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$desktopDir = Join-Path $workspace 'desktop'
$manifestPath = Join-Path $workspace 'frontend/public/download/desktop-latest.json'

if ($RemoteDownloadRoot -ne '/opt/zhicui/frontend/public/download') {
    throw "拒绝发布到未批准的目录：$RemoteDownloadRoot"
}
if ($ReleaseNotes.Count -lt 1 -or $ReleaseNotes.Count -gt 20) {
    throw '更新日志必须包含 1 到 20 条内容。'
}

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command 执行失败，退出码：$LASTEXITCODE"
    }
}

function Get-Sha512Base64 {
    param([string]$Path)
    $hex = (Get-FileHash -LiteralPath $Path -Algorithm SHA512).Hash
    $bytes = New-Object byte[] ($hex.Length / 2)
    for ($index = 0; $index -lt $bytes.Length; $index++) {
        $bytes[$index] = [Convert]::ToByte($hex.Substring($index * 2, 2), 16)
    }
    return [Convert]::ToBase64String($bytes)
}

$packagePath = Join-Path $desktopDir 'package.json'
$package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
if ([string]$package.version -ne $Version) {
    Push-Location $desktopDir
    try {
        Invoke-Checked 'npm.cmd' @('version', $Version, '--no-git-tag-version')
    } finally {
        Pop-Location
    }
}

$releaseDir = Join-Path $desktopDir "release-$Version"
if (-not $SkipBuild) {
    Push-Location $desktopDir
    try {
        Invoke-Checked 'npm.cmd' @('run', 'dist:win')
    } finally {
        Pop-Location
    }
}

$exeName = "Zhicui-Setup-$Version-x64.exe"
$blockmapName = "$exeName.blockmap"
$exePath = Join-Path $releaseDir $exeName
$blockmapPath = Join-Path $releaseDir $blockmapName
$latestPath = Join-Path $releaseDir 'latest.yml'
foreach ($artifact in @($exePath, $blockmapPath, $latestPath)) {
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
        throw "缺少 Windows 更新产物：$artifact"
    }
    if ((Get-Item -LiteralPath $artifact).Length -le 0) {
        throw "Windows 更新产物为空：$artifact"
    }
}

$latestYaml = Get-Content -Raw -LiteralPath $latestPath
if ($latestYaml -notmatch "(?m)^version:\s*$([regex]::Escape($Version))\s*$") {
    throw 'latest.yml 的版本号与发布版本不一致。'
}
if ($latestYaml -notmatch "(?m)^\s*-\s+url:\s*$([regex]::Escape($exeName))\s*$") {
    throw 'latest.yml 未引用本次版本化安装包。'
}
$expectedSha512 = Get-Sha512Base64 -Path $exePath
if ($latestYaml -notmatch "(?m)^\s*sha512:\s*$([regex]::Escape($expectedSha512))\s*$") {
    throw '安装包 SHA-512 与 latest.yml 不一致，拒绝发布。'
}

$signature = Get-AuthenticodeSignature -LiteralPath $exePath
$codeSigned = $signature.Status -eq 'Valid'
if (-not $codeSigned -and -not $AllowUnsigned) {
    throw '安装包没有有效 Windows 代码签名。测试发布请显式添加 -AllowUnsigned。'
}

$publishedAt = (Get-Date).ToUniversalTime().ToString('o')
$manifest = [ordered]@{
    schema_version = 1
    platform = 'windows'
    architecture = 'x64'
    version = $Version
    download_url = "https://luxai.cn/download/windows/$exeName"
    url = "https://luxai.cn/download/windows/$exeName"
    size_bytes = (Get-Item -LiteralPath $exePath).Length
    published_at = $publishedAt
    notes = @($ReleaseNotes | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    code_signed = $codeSigned
    release_status = if ($Publish) { 'public_download' } else { 'build_ready' }
}
[System.IO.File]::WriteAllText(
    $manifestPath,
    (($manifest | ConvertTo-Json -Depth 5) + "`n"),
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Windows 更新产物已验证：$releaseDir" -ForegroundColor Green
Write-Host "SHA-512：$expectedSha512"

if (-not $Publish) {
    Write-Host '尚未上传。确认后使用同一命令追加 -Publish。' -ForegroundColor Yellow
    exit 0
}

$remoteFeedDir = "$RemoteDownloadRoot/windows"
$remoteStagingDir = "/tmp/zhicui-desktop-$Version-$PID"
Invoke-Checked 'ssh.exe' @(
    '-o', 'BatchMode=yes',
    $Server,
    "mkdir -p '$remoteStagingDir'"
)
Invoke-Checked 'scp.exe' @(
    '-o', 'BatchMode=yes',
    $exePath,
    $blockmapPath,
    $latestPath,
    $manifestPath,
    "${Server}:$remoteStagingDir/"
)

$expectedSha512Hex = (Get-FileHash -LiteralPath $exePath -Algorithm SHA512).Hash.ToLowerInvariant()
$remoteCommand = @"
set -eu
feed='$remoteFeedDir'
root='$RemoteDownloadRoot'
staging='$remoteStagingDir'
test -s "`$staging/$exeName"
test -s "`$staging/$blockmapName"
test -s "`$staging/latest.yml"
actual=`$(sha512sum "`$staging/$exeName" | awk '{print tolower(`$1)}')
test "`$actual" = '$expectedSha512Hex'
sudo mkdir -p "`$feed"
sudo install -m 0644 "`$staging/$exeName" "`$feed/$exeName"
sudo install -m 0644 "`$staging/$blockmapName" "`$feed/$blockmapName"
sudo ln -sfn "$exeName" "`$feed/.latest-link-$Version"
sudo mv -Tf "`$feed/.latest-link-$Version" "`$feed/Zhicui-Setup-latest-x64.exe"
sudo install -m 0644 "`$staging/desktop-latest.json" "`$root/.desktop-latest-$Version.json"
sudo mv -Tf "`$root/.desktop-latest-$Version.json" "`$root/desktop-latest.json"
sudo install -m 0644 "`$staging/latest.yml" "`$feed/.latest-$Version.yml"
sudo mv -Tf "`$feed/.latest-$Version.yml" "`$feed/latest.yml"
rm -f -- "`$staging/$exeName" "`$staging/$blockmapName" "`$staging/latest.yml" "`$staging/desktop-latest.json"
rmdir "`$staging"
"@
Invoke-Checked 'ssh.exe' @('-o', 'BatchMode=yes', $Server, $remoteCommand)

Write-Host "发布完成：https://luxai.cn/download/windows/latest.yml" -ForegroundColor Green
Write-Host "公开安装包：https://luxai.cn/download/windows/$exeName" -ForegroundColor Green
