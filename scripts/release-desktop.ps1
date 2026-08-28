[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{40}$')]
    [string]$Commit,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,

    [ValidateSet('Beta', 'Stable')]
    [string]$Channel = 'Beta',

    [string[]]$ReleaseNotes = @(
        '支持后台下载桌面端更新，并在左下角显示实时进度。',
        '下载完成后可一键重启并安装，新版会自动回到知萃。',
        '网页功能更新与原生客户端更新采用独立、安全的发布通道。'
    ),

    [string]$Server = 'ubuntu@124.223.193.227',
    [string]$RemoteDownloadRoot = '/var/lib/zhicui-downloads',
    [switch]$Publish,
    [switch]$SkipBuild,
    # 仅保留旧命令兼容；beta 原本就允许未签名，stable 永远不接受此开关。
    [switch]$AllowUnsigned,

    [string]$ArtifactCacheRoot = '',

    [Parameter(DontShow = $true)]
    [switch]$InternalWorktree,

    [Parameter(DontShow = $true)]
    [string]$CallerWorkspace = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$channelName = $Channel.ToLowerInvariant()
$isStable = $channelName -eq 'stable'

$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$desktopDir = Join-Path $workspace 'desktop'
$releaseManifestDir = Join-Path $workspace 'frontend/public/download/releases/windows'
$channelManifestPath = Join-Path $releaseManifestDir "$channelName.json"
$legacyManifestPath = Join-Path $workspace 'frontend/public/download/desktop-latest.json'

if ($RemoteDownloadRoot -ne '/var/lib/zhicui-downloads') {
    throw "拒绝发布到未批准的目录：$RemoteDownloadRoot"
}
if ($ReleaseNotes.Count -lt 1 -or $ReleaseNotes.Count -gt 20) {
    throw '更新日志必须包含 1 到 20 条内容。'
}
if ($isStable -and $AllowUnsigned) {
    throw 'Stable 通道不接受 -AllowUnsigned。请配置可信 Authenticode 凭据。'
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

function Find-SignTool {
    $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
    if (-not (Test-Path -LiteralPath $kitsRoot)) { return $null }
    return Get-ChildItem -LiteralPath $kitsRoot -Directory |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName 'x64/signtool.exe' } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
}

# 外层只解析调用方显式给出的完整提交并创建临时 detached worktree。
# 随后改由该提交中的脚本执行，主 checkout 的已修改/未追踪文件不参与编译。
if (-not $InternalWorktree) {
    $resolvedCommit = (& git.exe -C $workspace rev-parse --verify "$Commit`^{commit}" 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($resolvedCommit)) {
        throw 'Commit 不存在或不是提交对象。'
    }
    $resolvedCommit = $resolvedCommit.Trim().ToLowerInvariant()
    if ($resolvedCommit -ne $Commit.ToLowerInvariant()) {
        throw 'Commit 必须是完整、不可变的 40 位提交 SHA。'
    }
    $worktreeParent = Join-Path ([System.IO.Path]::GetTempPath()) (
        "zhicui-windows-release-$PID-$([Guid]::NewGuid().ToString('N'))"
    )
    $worktree = Join-Path $worktreeParent 'source'
    New-Item -ItemType Directory -Path $worktreeParent | Out-Null
    $worktreeCreated = $false
    try {
        Invoke-Checked 'git.exe' @('-C', $workspace, 'worktree', 'add', '--detach', $worktree, $resolvedCommit)
        $worktreeCreated = $true
        $worktreeHead = (& git.exe -C $worktree rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0 -or $worktreeHead -ne $resolvedCommit) {
            throw '隔离 worktree 的提交身份校验失败。'
        }
        $worktreeStatus = (& git.exe -C $worktree status --porcelain=v1 --untracked-files=all | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $worktreeStatus) {
            throw '新建隔离 worktree 不是干净状态。'
        }
        $childParameters = @{
            Commit = $resolvedCommit
            Version = $Version
            Channel = $Channel
            ReleaseNotes = $ReleaseNotes
            Server = $Server
            RemoteDownloadRoot = $RemoteDownloadRoot
            ArtifactCacheRoot = $ArtifactCacheRoot
            InternalWorktree = $true
            CallerWorkspace = $workspace
        }
        if ($Publish) { $childParameters.Publish = $true }
        if ($SkipBuild) { $childParameters.SkipBuild = $true }
        if ($AllowUnsigned) { $childParameters.AllowUnsigned = $true }
        & (Join-Path $worktree 'scripts/release-desktop.ps1') @childParameters
    } finally {
        if ($worktreeCreated) {
            & git.exe -C $workspace worktree remove --force $worktree *> $null
        }
        if (Test-Path -LiteralPath $worktreeParent -PathType Container) {
            Remove-Item -LiteralPath $worktreeParent -Force
        }
    }
    return
}

$resolvedCommit = (& git.exe -C $workspace rev-parse HEAD).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $resolvedCommit -ne $Commit.ToLowerInvariant()) {
    throw '构建 worktree 与 Commit 不一致。'
}
& git.exe -C $workspace symbolic-ref -q HEAD *> $null
if ($LASTEXITCODE -eq 0) {
    throw 'Windows 发行构建必须运行在 detached worktree。'
}
$worktreeStatus = (& git.exe -C $workspace status --porcelain=v1 --untracked-files=all | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $worktreeStatus) {
    throw '隔离 worktree 在依赖安装前已被污染。'
}
if ([string]::IsNullOrWhiteSpace($CallerWorkspace)) {
    throw '隔离构建缺少调用方仓库路径。'
}
$CallerWorkspace = (Resolve-Path -LiteralPath $CallerWorkspace).Path
if ([string]::IsNullOrWhiteSpace($ArtifactCacheRoot)) {
    $cacheBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [System.IO.Path]::GetTempPath() }
    $ArtifactCacheRoot = Join-Path $cacheBase 'Zhicui/release-cache/windows'
}
$ArtifactCacheRoot = [System.IO.Path]::GetFullPath($ArtifactCacheRoot)
$workspaceBoundary = $workspace.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$callerBoundary = $CallerWorkspace.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (
    $ArtifactCacheRoot.Equals($workspace, [System.StringComparison]::OrdinalIgnoreCase) -or
    $ArtifactCacheRoot.StartsWith($workspaceBoundary, [System.StringComparison]::OrdinalIgnoreCase) -or
    $ArtifactCacheRoot.Equals($CallerWorkspace, [System.StringComparison]::OrdinalIgnoreCase) -or
    $ArtifactCacheRoot.StartsWith($callerBoundary, [System.StringComparison]::OrdinalIgnoreCase)
) {
    throw 'ArtifactCacheRoot 必须位于 Git checkout/worktree 之外。'
}
$cacheDir = Join-Path $ArtifactCacheRoot "$resolvedCommit/$channelName/$Version"
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

$publisher = ($env:ZHICUI_WINDOWS_PUBLISHER ?? '').Trim()
$timestampUrl = ($env:ZHICUI_WINDOWS_TIMESTAMP_URL ?? 'http://timestamp.digicert.com').Trim()
if ($isStable) {
    $missing = @()
    foreach ($name in @('CSC_LINK', 'CSC_KEY_PASSWORD', 'ZHICUI_WINDOWS_PUBLISHER')) {
        if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
            $missing += $name
        }
    }
    if ($missing.Count -gt 0) {
        throw "Stable 构建缺少受限凭据：$($missing -join ', ')。未读取或输出任何秘密值。"
    }
    if ($timestampUrl -notmatch '^https?://') {
        throw 'ZHICUI_WINDOWS_TIMESTAMP_URL 必须是 HTTP(S) 时间戳服务。'
    }
}

$packagePath = Join-Path $desktopDir 'package.json'
$package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
if ([string]$package.version -ne $Version) {
    throw "指定提交中的 desktop/package.json 版本为 $($package.version)，与 -Version $Version 不一致；请先提交版本升级。"
}

Push-Location $desktopDir
try {
    Invoke-Checked 'npm.cmd' @('ci', '--silent')
    Invoke-Checked 'npm.cmd' @('run', 'verify:release-contract')
} finally {
    Pop-Location
}

$exeName = "Zhicui-Setup-$Version-x64.exe"
$blockmapName = "$exeName.blockmap"
$provenancePath = Join-Path $cacheDir 'provenance.json'
$cachedProvenance = $null

if ($SkipBuild) {
    if (-not (Test-Path -LiteralPath $provenancePath -PathType Leaf)) {
        throw "-SkipBuild 仅可复用同一提交的隔离构建缓存；未找到来源记录：$provenancePath"
    }
    $cachedProvenance = Get-Content -Raw -LiteralPath $provenancePath | ConvertFrom-Json
    if (
        $cachedProvenance.schema_version -ne 1 -or
        $cachedProvenance.source_commit -ne $resolvedCommit -or
        $cachedProvenance.channel -ne $channelName -or
        $cachedProvenance.version -ne $Version -or
        $cachedProvenance.installer.name -ne $exeName -or
        [string]::IsNullOrWhiteSpace([string]$cachedProvenance.feed.name)
    ) {
        throw '-SkipBuild 缓存的提交、渠道、版本或文件身份不匹配。'
    }
    $currentScriptSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $currentLockSha256 = (Get-FileHash -LiteralPath (Join-Path $desktopDir 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    if (
        $cachedProvenance.release_script_sha256 -ne $currentScriptSha256 -or
        $cachedProvenance.package_lock_sha256 -ne $currentLockSha256
    ) {
        throw '-SkipBuild 缓存不是由当前提交中的发行脚本和依赖锁生成，拒绝复用。'
    }
    $releaseDir = $cacheDir
    $exePath = Join-Path $cacheDir $exeName
    $blockmapPath = Join-Path $cacheDir $blockmapName
    $generatedFeedPath = Join-Path $cacheDir ([string]$cachedProvenance.feed.name)
} else {
    $releaseDir = Join-Path $desktopDir "release-$Version"
    $builderConfigPath = Join-Path $desktopDir ".electron-builder-release-$PID.json"
    $buildConfig = $package.build | ConvertTo-Json -Depth 30 | ConvertFrom-Json
    $publishers = @($buildConfig.publish)
    if ($publishers.Count -ne 1 -or $publishers[0].provider -ne 'generic') {
        throw 'Windows 发布配置必须且只能包含一个 generic provider。'
    }
    $publishers[0].channel = $channelName
    $buildConfig.publish = @($publishers)
    $buildConfig | Add-Member -NotePropertyName extraMetadata -NotePropertyValue (
        [pscustomobject]@{ releaseChannel = $channelName }
    ) -Force
    if ($isStable) {
        $buildConfig.win.signtoolOptions | Add-Member -NotePropertyName publisherName -NotePropertyValue $publisher -Force
        $buildConfig.win.signtoolOptions | Add-Member -NotePropertyName timeStampServer -NotePropertyValue $timestampUrl -Force
        $buildConfig.win.signtoolOptions | Add-Member -NotePropertyName rfc3161TimeStampServer -NotePropertyValue $timestampUrl -Force
    }
    [System.IO.File]::WriteAllText(
        $builderConfigPath,
        (($buildConfig | ConvertTo-Json -Depth 30) + "`n"),
        [System.Text.UTF8Encoding]::new($false)
    )
    Push-Location $desktopDir
    try {
        Invoke-Checked 'npm.cmd' @('run', 'build')
        Invoke-Checked 'npm.cmd' @('run', 'patch:builder')
        $builderArgs = @(
            'electron-builder', '--win', 'nsis', '--x64',
            '--config', $builderConfigPath
        )
        Invoke-Checked 'npx.cmd' $builderArgs
    } finally {
        Pop-Location
        if (Test-Path -LiteralPath $builderConfigPath) {
            Remove-Item -LiteralPath $builderConfigPath -Force
        }
    }
    $exePath = Join-Path $releaseDir $exeName
    $blockmapPath = Join-Path $releaseDir $blockmapName
    $generatedFeedCandidates = @(
        (Join-Path $releaseDir "$channelName.yml"),
        (Join-Path $releaseDir 'latest.yml')
    )
    $generatedFeedPath = $generatedFeedCandidates |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
}

foreach ($artifact in @($exePath, $blockmapPath, $generatedFeedPath)) {
    if ([string]::IsNullOrWhiteSpace([string]$artifact) -or -not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
        throw "缺少 Windows 更新产物：$artifact"
    }
    if ((Get-Item -LiteralPath $artifact).Length -le 0) {
        throw "Windows 更新产物为空：$artifact"
    }
}

$feedText = Get-Content -Raw -LiteralPath $generatedFeedPath
if ($feedText -notmatch "(?m)^version:\s*$([regex]::Escape($Version))\s*$") {
    throw '更新 feed 的版本号与发布版本不一致。'
}
if ($feedText -notmatch "(?m)^\s*-\s+url:\s*$([regex]::Escape($exeName))\s*$") {
    throw '更新 feed 未引用本次版本化安装包。'
}
$expectedSha512 = Get-Sha512Base64 -Path $exePath
if ($feedText -notmatch "(?m)^\s*sha512:\s*$([regex]::Escape($expectedSha512))\s*$") {
    throw '安装包 SHA-512 与更新 feed 不一致，拒绝发布。'
}

$sha256 = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant()
$blockmapSha256 = (Get-FileHash -LiteralPath $blockmapPath -Algorithm SHA256).Hash.ToLowerInvariant()
$feedSha256 = (Get-FileHash -LiteralPath $generatedFeedPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($SkipBuild) {
    if (
        $cachedProvenance.installer.sha256 -ne $sha256 -or
        $cachedProvenance.installer.sha512 -ne $expectedSha512 -or
        [long]$cachedProvenance.installer.size_bytes -ne (Get-Item -LiteralPath $exePath).Length -or
        $cachedProvenance.blockmap.sha256 -ne $blockmapSha256 -or
        [long]$cachedProvenance.blockmap.size_bytes -ne (Get-Item -LiteralPath $blockmapPath).Length -or
        $cachedProvenance.feed.sha256 -ne $feedSha256 -or
        [long]$cachedProvenance.feed.size_bytes -ne (Get-Item -LiteralPath $generatedFeedPath).Length
    ) {
        throw '-SkipBuild 缓存哈希或大小与来源记录不一致，拒绝复用。'
    }
}
$signature = Get-AuthenticodeSignature -LiteralPath $exePath
$codeSigned = $signature.Status -eq 'Valid'
$timestampVerified = $null -ne $signature.TimeStamperCertificate
$actualPublisher = if ($signature.SignerCertificate) {
    $signature.SignerCertificate.GetNameInfo(
        [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
        $false
    )
} else { $null }

if ($isStable) {
    if (-not $codeSigned) {
        throw "Stable 安装包 Authenticode 无效：$($signature.Status)"
    }
    if ($actualPublisher -ne $publisher) {
        throw 'Stable 发布者身份不匹配。期望配置名称与证书 SimpleName 不一致。'
    }
    if (-not $timestampVerified) {
        throw 'Stable 安装包缺少可信时间戳。'
    }
    $signTool = Find-SignTool
    if (-not $signTool) {
        throw 'Stable 验证缺少 Windows SDK signtool.exe。'
    }
    $signToolOutput = (& $signTool verify /pa /all /v $exePath 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -or $signToolOutput -notmatch 'Successfully verified') {
        throw 'signtool 未能验证 Stable 安装包签名链。'
    }
    if ($signToolOutput -notmatch '(?i)sha256') {
        throw 'signtool 结果未确认 SHA-256 签名/摘要。'
    }
} elseif (-not $codeSigned) {
    Write-Host 'Beta 安装包未签名，将仅写入公测清单。' -ForegroundColor Yellow
}

if (-not $SkipBuild) {
    $cachedExePath = Join-Path $cacheDir $exeName
    $cachedBlockmapPath = Join-Path $cacheDir $blockmapName
    $cachedFeedPath = Join-Path $cacheDir (Split-Path -Leaf $generatedFeedPath)
    Copy-Item -LiteralPath $exePath -Destination $cachedExePath -Force
    Copy-Item -LiteralPath $blockmapPath -Destination $cachedBlockmapPath -Force
    Copy-Item -LiteralPath $generatedFeedPath -Destination $cachedFeedPath -Force
    $provenance = [ordered]@{
        schema_version = 1
        source_commit = $resolvedCommit
        channel = $channelName
        version = $Version
        created_at = (Get-Date).ToUniversalTime().ToString('o')
        release_script_sha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
        package_lock_sha256 = (Get-FileHash -LiteralPath (Join-Path $desktopDir 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        installer = [ordered]@{
            name = $exeName
            size_bytes = (Get-Item -LiteralPath $cachedExePath).Length
            sha256 = $sha256
            sha512 = $expectedSha512
        }
        blockmap = [ordered]@{
            name = $blockmapName
            size_bytes = (Get-Item -LiteralPath $cachedBlockmapPath).Length
            sha256 = $blockmapSha256
        }
        feed = [ordered]@{
            name = (Split-Path -Leaf $cachedFeedPath)
            size_bytes = (Get-Item -LiteralPath $cachedFeedPath).Length
            sha256 = $feedSha256
        }
    }
    $temporaryProvenance = "$provenancePath.tmp-$PID"
    [System.IO.File]::WriteAllText(
        $temporaryProvenance,
        (($provenance | ConvertTo-Json -Depth 6) + "`n"),
        [System.Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryProvenance -Destination $provenancePath -Force
}

$publishedAt = (Get-Date).ToUniversalTime().ToString('o')
$manifest = [ordered]@{
    schema_version = 2
    channel = $channelName
    availability = 'available'
    platform = 'windows'
    architecture = 'x64'
    artifact_kind = if ($codeSigned) { 'authenticode' } else { 'unsigned' }
    version = $Version
    source_commit = $resolvedCommit
    download_url = "https://luxai.cn/download/windows/$exeName"
    size_bytes = (Get-Item -LiteralPath $exePath).Length
    sha256 = $sha256
    published_at = $publishedAt
    release_notes = @($ReleaseNotes | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    code_signed = $codeSigned
    signing = [ordered]@{
        verified = $codeSigned
        publisher = $actualPublisher
        timestamp_verified = $timestampVerified
    }
}
New-Item -ItemType Directory -Force -Path $releaseManifestDir | Out-Null
[System.IO.File]::WriteAllText(
    $channelManifestPath,
    (($manifest | ConvertTo-Json -Depth 6) + "`n"),
    [System.Text.UTF8Encoding]::new($false)
)

if (-not $isStable) {
    $legacy = [ordered]@{
        schema_version = 1
        channel = 'beta'
        availability = 'available'
        platform = 'windows'
        architecture = 'x64'
        artifact_kind = if ($codeSigned) { 'authenticode' } else { 'unsigned' }
        version = $Version
        source_commit = $resolvedCommit
        download_url = "https://luxai.cn/download/windows/$exeName"
        url = "https://luxai.cn/download/windows/$exeName"
        size_bytes = (Get-Item -LiteralPath $exePath).Length
        sha256 = $sha256
        published_at = $publishedAt
        notes = @($ReleaseNotes | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        code_signed = $codeSigned
        release_status = 'beta_download'
    }
    [System.IO.File]::WriteAllText(
        $legacyManifestPath,
        (($legacy | ConvertTo-Json -Depth 6) + "`n"),
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Copy-ReleaseOutput {
    param([string]$Source, [string]$Destination)
    $destinationDirectory = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
    $temporary = "$Destination.tmp-$PID"
    Copy-Item -LiteralPath $Source -Destination $temporary -Force
    Move-Item -LiteralPath $temporary -Destination $Destination -Force
}

$callerReleaseDir = Join-Path $CallerWorkspace "desktop/release-$Version"
Copy-ReleaseOutput -Source $exePath -Destination (Join-Path $callerReleaseDir $exeName)
Copy-ReleaseOutput -Source $blockmapPath -Destination (Join-Path $callerReleaseDir $blockmapName)
Copy-ReleaseOutput -Source $generatedFeedPath -Destination (
    Join-Path $callerReleaseDir (Split-Path -Leaf $generatedFeedPath)
)
Copy-ReleaseOutput -Source $channelManifestPath -Destination (
    Join-Path $CallerWorkspace "frontend/public/download/releases/windows/$channelName.json"
)
if (-not $isStable) {
    Copy-ReleaseOutput -Source $legacyManifestPath -Destination (
        Join-Path $CallerWorkspace 'frontend/public/download/desktop-latest.json'
    )
}

Write-Host "Windows $Channel 产物已从提交 $resolvedCommit 验证并记录：$cacheDir" -ForegroundColor Green
Write-Host "SHA-256：$sha256"
Write-Host "SHA-512：$expectedSha512"

if (-not $Publish) {
    Write-Host "尚未上传。可使用同一 -Commit $resolvedCommit 命令追加 -SkipBuild -Publish，脚本会重新核验隔离缓存。" -ForegroundColor Yellow
    return
}

$remoteFeedDir = "$RemoteDownloadRoot/windows"
$remoteManifestDir = "$RemoteDownloadRoot/releases/windows"
$remoteStagingDir = "/tmp/zhicui-desktop-$Version-$channelName-$PID"
$feedFileName = "$channelName.yml"
$generatedFeedName = Split-Path -Leaf $generatedFeedPath
$channelManifestName = Split-Path -Leaf $channelManifestPath
Invoke-Checked 'ssh.exe' @('-o', 'BatchMode=yes', $Server, "mkdir -p '$remoteStagingDir'")
Invoke-Checked 'scp.exe' @(
    '-o', 'BatchMode=yes',
    $exePath,
    $blockmapPath,
    $generatedFeedPath,
    $channelManifestPath,
    "${Server}:$remoteStagingDir/"
)

$remoteCommand = @"
set -eu
feed='$remoteFeedDir'
manifests='$remoteManifestDir'
staging='$remoteStagingDir'
test -s "`$staging/$exeName"
actual=`$(sha256sum "`$staging/$exeName" | awk '{print tolower(`$1)}')
test "`$actual" = '$sha256'
sudo mkdir -p "`$feed" "`$manifests"
sudo install -m 0644 "`$staging/$exeName" "`$feed/$exeName"
sudo install -m 0644 "`$staging/$blockmapName" "`$feed/$blockmapName"
sudo install -m 0644 "`$staging/$generatedFeedName" "`$feed/.$feedFileName.tmp"
sudo mv -Tf "`$feed/.$feedFileName.tmp" "`$feed/$feedFileName"
sudo install -m 0644 "`$staging/$channelManifestName" "`$manifests/.$channelName.json.tmp"
sudo mv -Tf "`$manifests/.$channelName.json.tmp" "`$manifests/$channelName.json"
"@
if (-not $isStable) {
    $remoteCommand += @"
sudo ln -sfn "$exeName" "`$feed/.latest-link-$Version"
sudo mv -Tf "`$feed/.latest-link-$Version" "`$feed/Zhicui-Setup-latest-x64.exe"
sudo install -m 0644 "`$feed/$feedFileName" "`$feed/.latest.yml.tmp"
sudo mv -Tf "`$feed/.latest.yml.tmp" "`$feed/latest.yml"
"@
}
$remoteCommand += @"
rm -f -- "`$staging/$exeName" "`$staging/$blockmapName" "`$staging/$generatedFeedName" "`$staging/$channelManifestName"
rmdir "`$staging"
"@
Invoke-Checked 'ssh.exe' @('-o', 'BatchMode=yes', $Server, $remoteCommand)

Write-Host "发布完成：https://luxai.cn/download/windows/$feedFileName" -ForegroundColor Green
Write-Host "版本化安装包：https://luxai.cn/download/windows/$exeName" -ForegroundColor Green
