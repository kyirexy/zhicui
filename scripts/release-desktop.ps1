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
        '新增知萃 Agent 接入中心，可连接 Codex 与 Claude Code。',
        '内置 zhicui CLI 与本地 MCP，并支持云端普通用户能力。',
        '新增独立凭证、最小权限、运行隔离和可撤销授权。'
    ),

    [string]$Server = 'ubuntu@124.223.193.227',
    [string]$RemoteDownloadRoot = '/var/lib/zhicui-downloads',
    [switch]$Publish,
    [switch]$SkipBuild,
    # 仅保留旧命令兼容；beta 原本就允许未签名，stable 永远不接受此开关。
    [switch]$AllowUnsigned,

    [string]$ArtifactCacheRoot = '',

    # Stable 发布前必须由真实 Windows 机器完成全新安装、升级和回滚恢复验收。
    # 证据只记录脱敏设备指纹，并在发行清单中绑定其 SHA-256。
    [string]$StableSmokeEvidencePath = '',

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
    # Windows checkout 的 here-string 可能保留 CRLF，远端 Bash 只接受 LF。
    if ($Command -eq 'ssh.exe') {
        $Arguments = @($Arguments | ForEach-Object { $_.Replace("`r`n", "`n") })
    }
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

function Get-CertificateSha256 {
    param(
        [System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate
    )
    if (-not $Certificate) { return $null }
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $hasher.ComputeHash($Certificate.RawData)
        return ([System.BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant()
    } finally {
        $hasher.Dispose()
    }
}

function Assert-ExternalEvidencePath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'Stable 发布需要可读的 -StableSmokeEvidencePath。'
    }
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    foreach ($checkout in @($workspace, $CallerWorkspace)) {
        if ([string]::IsNullOrWhiteSpace($checkout)) { continue }
        $root = [System.IO.Path]::GetFullPath($checkout)
        $boundary = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        if (
            $resolved.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or
            $resolved.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)
        ) {
            throw 'Stable 客户端验收证据必须位于 Git checkout/worktree 之外。'
        }
    }
    return $resolved
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

function Assert-PublicReleaseUri {
    param(
        [Parameter(Mandatory = $true)][Uri]$Uri,
        [Parameter(Mandatory = $true)][string]$ExpectedPath
    )
    if (
        $Uri.Scheme -ne 'https' -or
        -not $Uri.IsDefaultPort -or
        -not [string]::Equals($Uri.Host, 'luxai.cn', [StringComparison]::OrdinalIgnoreCase) -or
        $Uri.AbsolutePath -ne $ExpectedPath
    ) {
        throw "公网回读地址越界：$($Uri.AbsoluteUri)"
    }
}

function Invoke-StrictPublicDownload {
    param(
        [Parameter(Mandatory = $true)][Uri]$Uri,
        [Parameter(Mandatory = $true)][string]$ExpectedPath,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    Assert-PublicReleaseUri -Uri $Uri -ExpectedPath $ExpectedPath
    Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
    $separator = if ($Uri.Query) { '&' } else { '?' }
    $requestUri = [Uri]("$($Uri.AbsoluteUri)${separator}zhicui_readback=$([Guid]::NewGuid().ToString('N'))")
    Assert-PublicReleaseUri -Uri $requestUri -ExpectedPath $ExpectedPath

    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(10)
    $request = [System.Net.Http.HttpRequestMessage]::new(
        [System.Net.Http.HttpMethod]::Get,
        $requestUri
    )
    $request.Headers.CacheControl = [System.Net.Http.Headers.CacheControlHeaderValue]::Parse(
        'no-cache, no-store, max-age=0'
    )
    $response = $null
    $inputStream = $null
    $outputStream = $null
    try {
        $response = $client.SendAsync(
            $request,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
        ).GetAwaiter().GetResult()
        if ([int]$response.StatusCode -ne 200) {
            throw "公网回读返回 HTTP $([int]$response.StatusCode)：$ExpectedPath"
        }
        Assert-PublicReleaseUri -Uri $response.RequestMessage.RequestUri -ExpectedPath $ExpectedPath
        $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $outputStream = [System.IO.File]::Open(
            $Destination,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $inputStream.CopyToAsync($outputStream).GetAwaiter().GetResult()
        $outputStream.Flush($true)
    } finally {
        if ($outputStream) { $outputStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Dispose() }
        $request.Dispose()
        $client.Dispose()
        $handler.Dispose()
    }
}

# 外层只解析调用方显式给出的完整提交并创建临时 detached worktree。
# 随后改由该提交中的脚本执行，主 checkout 的已修改/未追踪文件不参与编译。
if (-not $InternalWorktree) {
    # 不通过 Select-Object 提前关闭原生命令管道，确保读取到真实退出码。
    $resolvedCommit = & git.exe -C $workspace rev-parse --verify "$Commit`^{commit}" 2>$null
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
            StableSmokeEvidencePath = $StableSmokeEvidencePath
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
$expectedCertificateSha256 = (($env:ZHICUI_WINDOWS_CERT_SHA256 ?? '') -replace '[:\s]', '').ToLowerInvariant()
if ($isStable) {
    $missing = @()
    foreach ($name in @(
        'CSC_LINK',
        'CSC_KEY_PASSWORD',
        'ZHICUI_WINDOWS_PUBLISHER',
        'ZHICUI_WINDOWS_CERT_SHA256'
    )) {
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
    if ($expectedCertificateSha256 -notmatch '^[0-9a-f]{64}$') {
        throw 'ZHICUI_WINDOWS_CERT_SHA256 必须是 64 位证书 SHA-256 指纹。'
    }
}

$packagePath = Join-Path $desktopDir 'package.json'
$package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
if ([string]$package.version -ne $Version) {
    throw "指定提交中的 desktop/package.json 版本为 $($package.version)，与 -Version $Version 不一致；请先提交版本升级。"
}
$requestedVersion = [Version]$Version
$publishedVersions = @()
foreach ($manifestPath in @(
    (Join-Path $releaseManifestDir 'beta.json'),
    (Join-Path $releaseManifestDir 'stable.json'),
    $legacyManifestPath
)) {
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { continue }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if (
        $manifest.availability -eq 'unavailable' -or
        [string]::IsNullOrWhiteSpace([string]$manifest.version)
    ) { continue }
    try { $publishedVersions += [Version]([string]$manifest.version) }
    catch { throw "已发布清单版本格式无效：$manifestPath" }
}
if ($Publish) {
    foreach ($remoteChannel in @('beta', 'stable')) {
        $remoteManifestUrl = "https://luxai.cn/download/releases/windows/$remoteChannel.json"
        try {
            $remoteManifest = Invoke-RestMethod -Uri $remoteManifestUrl -Method Get -TimeoutSec 15
        } catch {
            throw "无法读取线上 Windows $remoteChannel 发行账本，拒绝发布：$remoteManifestUrl"
        }
        if (
            [int]$remoteManifest.schema_version -lt 2 -or
            [string]$remoteManifest.channel -ne $remoteChannel -or
            [string]$remoteManifest.platform -ne 'windows' -or
            [string]$remoteManifest.availability -notin @('available', 'unavailable')
        ) {
            throw "线上 Windows $remoteChannel 发行账本格式无效，拒绝发布。"
        }
        if (
            [string]$remoteManifest.availability -eq 'available' -and
            -not [string]::IsNullOrWhiteSpace([string]$remoteManifest.version)
        ) {
            try { $publishedVersions += [Version]([string]$remoteManifest.version) }
            catch { throw "线上 Windows $remoteChannel 发行账本版本格式无效。" }
        }
    }
}
if ($publishedVersions.Count -gt 0) {
    $highestPublished = $publishedVersions | Sort-Object -Descending | Select-Object -First 1
    if ($requestedVersion -le $highestPublished) {
        throw "版本 $Version 必须高于全部已发布 Windows 版本（当前最高 $highestPublished），防止同一 SemVer 对应不同二进制。"
    }
}

Push-Location $desktopDir
try {
    Invoke-Checked 'npm.cmd' @('ci', '--silent')
    Invoke-Checked 'npm.cmd' @('run', 'prepare:cli')
    Invoke-Checked 'npm.cmd' @('run', 'verify:agent-integration')
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
$actualCertificateSha256 = Get-CertificateSha256 -Certificate $signature.SignerCertificate
$timestampCertificateSha256 = Get-CertificateSha256 -Certificate $signature.TimeStamperCertificate
$stableSmokeEvidence = $null
$stableSmokeEvidenceSha256 = $null

if ($isStable) {
    if (-not $codeSigned) {
        throw "Stable 安装包 Authenticode 无效：$($signature.Status)"
    }
    if ($actualPublisher -ne $publisher) {
        throw 'Stable 发布者身份不匹配。期望配置名称与证书 SimpleName 不一致。'
    }
    if ($actualCertificateSha256 -ne $expectedCertificateSha256) {
        throw 'Stable 签名证书 SHA-256 指纹与允许身份不一致。'
    }
    if (-not $timestampVerified) {
        throw 'Stable 安装包缺少可信时间戳。'
    }
    $signTool = Find-SignTool
    if (-not $signTool) {
        throw 'Stable 验证缺少 Windows SDK signtool.exe。'
    }
    $signToolOutput = (& $signTool verify /pa /all /tw /v $exePath 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -or $signToolOutput -notmatch 'Successfully verified') {
        throw 'signtool 未能验证 Stable 安装包签名链。'
    }
    if ($signToolOutput -notmatch '(?i)sha256') {
        throw 'signtool 结果未确认 SHA-256 签名/摘要。'
    }
    if ($SkipBuild -and (
        $cachedProvenance.signing.verified -ne $true -or
        [string]$cachedProvenance.signing.publisher -ne $actualPublisher -or
        [string]$cachedProvenance.signing.certificate_sha256 -ne $actualCertificateSha256 -or
        $cachedProvenance.signing.timestamp_verified -ne $true -or
        [string]$cachedProvenance.signing.timestamp_certificate_sha256 -ne $timestampCertificateSha256
    )) {
        throw '-SkipBuild 缓存的 Authenticode 身份或时间戳证据不一致。'
    }
    if ($Publish) {
        $StableSmokeEvidencePath = Assert-ExternalEvidencePath -Path $StableSmokeEvidencePath
        $evidenceVerifier = Join-Path $workspace 'scripts/verify-client-release-evidence.mjs'
        $evidenceArguments = @(
            $evidenceVerifier,
            '--platform=windows',
            "--evidence=$StableSmokeEvidencePath",
            "--source-commit=$resolvedCommit",
            "--version=$Version",
            "--artifact-sha256=$sha256"
        )
        $evidenceOutput = (& node.exe @evidenceArguments 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) {
            throw "Stable Windows 安装/更新/回滚证据校验失败：$($evidenceOutput.Trim())"
        }
        try {
            $stableSmokeEvidence = $evidenceOutput | ConvertFrom-Json
        } catch {
            throw 'Stable Windows 验收证据校验器未返回有效 JSON。'
        }
        $stableSmokeEvidenceSha256 = [string]$stableSmokeEvidence.sha256
        if ($stableSmokeEvidenceSha256 -notmatch '^[0-9a-f]{64}$') {
            throw 'Stable Windows 验收证据缺少有效 SHA-256。'
        }
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
        signing = [ordered]@{
            verified = $codeSigned
            publisher = $actualPublisher
            certificate_sha256 = $actualCertificateSha256
            timestamp_verified = $timestampVerified
            timestamp_certificate_sha256 = $timestampCertificateSha256
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
    blockmap = [ordered]@{
        name = $blockmapName
        download_url = "https://luxai.cn/download/windows/$blockmapName"
        size_bytes = (Get-Item -LiteralPath $blockmapPath).Length
        sha256 = $blockmapSha256
    }
    update_feed = [ordered]@{
        name = "$channelName.yml"
        download_url = "https://luxai.cn/download/windows/$channelName.yml"
        size_bytes = (Get-Item -LiteralPath $generatedFeedPath).Length
        sha256 = $feedSha256
    }
    published_at = $publishedAt
    release_notes = @($ReleaseNotes | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    code_signed = $codeSigned
    release_status = if ($isStable) { 'stable_download' } else { 'beta_download' }
    signing = [ordered]@{
        verified = $codeSigned
        publisher = $actualPublisher
        certificate_sha256 = $actualCertificateSha256
        timestamp_verified = $timestampVerified
        timestamp_certificate_sha256 = $timestampCertificateSha256
    }
    verification_evidence = if ($isStable -and $Publish) {
        [ordered]@{
            schema_version = 1
            sha256 = $stableSmokeEvidenceSha256
            completed_at = [string]$stableSmokeEvidence.completed_at
            device_fingerprint_sha256 = [string]$stableSmokeEvidence.device_fingerprint_sha256
        }
    } else { $null }
}
New-Item -ItemType Directory -Force -Path $releaseManifestDir | Out-Null
[System.IO.File]::WriteAllText(
    $channelManifestPath,
    (($manifest | ConvertTo-Json -Depth 6) + "`n"),
    [System.Text.UTF8Encoding]::new($false)
)
$manifestSha256 = (Get-FileHash -LiteralPath $channelManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()

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
$releaseNonce = [Guid]::NewGuid().ToString('N')
$remoteStagingDir = "/tmp/zhicui-desktop-$Version-$channelName-$releaseNonce"
$feedFileName = "$channelName.yml"
$generatedFeedName = Split-Path -Leaf $generatedFeedPath
$channelManifestName = Split-Path -Leaf $channelManifestPath
$systemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$readbackDir = $null
$stableRollbackPrepared = $false
$stablePromoted = $false
$releaseFailure = $null

$cleanupRemoteCommand = @"
set -eu
staging='$remoteStagingDir'
case "`$staging" in /tmp/zhicui-desktop-*) ;; *) exit 90 ;; esac
sudo rm -f -- \
  "`$staging/rollback/feed.previous" "`$staging/rollback/feed.sha256" "`$staging/rollback/feed.state" \
  "`$staging/rollback/manifest.previous" "`$staging/rollback/manifest.sha256" "`$staging/rollback/manifest.state"
rmdir "`$staging/rollback" 2>/dev/null || true
rm -f -- "`$staging/$exeName" "`$staging/$blockmapName" "`$staging/$generatedFeedName" "`$staging/$channelManifestName"
rmdir "`$staging" 2>/dev/null || true
"@

try {
    Invoke-Checked 'ssh.exe' @('-o', 'BatchMode=yes', $Server, "mkdir '$remoteStagingDir'")
    Invoke-Checked 'scp.exe' @(
        '-o', 'BatchMode=yes',
        $exePath,
        $blockmapPath,
        $generatedFeedPath,
        $channelManifestPath,
        "${Server}:$remoteStagingDir/"
    )

    if ($isStable) {
        # 先保存当前两个可变 channel 指针并安装不可变版本化文件。只有公网回读
        # 版本化文件通过后才切换 stable.json / stable.yml；任意后续失败都会恢复。
        $prepareStableCommand = @"
set -eu
feed='$remoteFeedDir'
manifests='$remoteManifestDir'
staging='$remoteStagingDir'
rollback="`$staging/rollback"
test -s "`$staging/$exeName"
test "`$(sha256sum "`$staging/$exeName" | awk '{print tolower(`$1)}')" = '$sha256'
test "`$(sha256sum "`$staging/$blockmapName" | awk '{print tolower(`$1)}')" = '$blockmapSha256'
test "`$(sha256sum "`$staging/$generatedFeedName" | awk '{print tolower(`$1)}')" = '$feedSha256'
test "`$(sha256sum "`$staging/$channelManifestName" | awk '{print tolower(`$1)}')" = '$manifestSha256'
sudo mkdir -p "`$feed" "`$manifests"
mkdir "`$rollback"
if sudo test -f "`$feed/$feedFileName"; then
  echo present >"`$rollback/feed.state"
  sudo sha256sum "`$feed/$feedFileName" | awk '{print tolower(`$1)}' >"`$rollback/feed.sha256"
  sudo cp -p -- "`$feed/$feedFileName" "`$rollback/feed.previous"
else
  echo absent >"`$rollback/feed.state"
fi
if sudo test -f "`$manifests/$channelName.json"; then
  echo present >"`$rollback/manifest.state"
  sudo sha256sum "`$manifests/$channelName.json" | awk '{print tolower(`$1)}' >"`$rollback/manifest.sha256"
  sudo cp -p -- "`$manifests/$channelName.json" "`$rollback/manifest.previous"
else
  echo absent >"`$rollback/manifest.state"
fi
if sudo test -e "`$feed/$exeName"; then
  test "`$(sudo sha256sum "`$feed/$exeName" | awk '{print tolower(`$1)}')" = '$sha256'
else
  sudo install -m 0644 "`$staging/$exeName" "`$feed/$exeName"
fi
if sudo test -e "`$feed/$blockmapName"; then
  test "`$(sudo sha256sum "`$feed/$blockmapName" | awk '{print tolower(`$1)}')" = '$blockmapSha256'
else
  sudo install -m 0644 "`$staging/$blockmapName" "`$feed/$blockmapName"
fi
"@
        Invoke-Checked 'ssh.exe' @('-o', 'BatchMode=yes', $Server, $prepareStableCommand)
        $stableRollbackPrepared = $true

        $readbackDir = Join-Path $systemTemp ("zhicui-stable-readback-$releaseNonce")
        New-Item -ItemType Directory -Path $readbackDir -ErrorAction Stop | Out-Null
        $publicManifestPath = "/download/releases/windows/$channelName.json"
        $publicInstallerPath = "/download/windows/$exeName"
        $publicBlockmapPath = "/download/windows/$blockmapName"
        $publicFeedPath = "/download/windows/$feedFileName"
        $publicManifestUrl = [Uri]("https://luxai.cn$publicManifestPath")
        $publicInstallerUrl = [Uri]("https://luxai.cn$publicInstallerPath")
        $publicBlockmapUrl = [Uri]("https://luxai.cn$publicBlockmapPath")
        $publicFeedUrl = [Uri]("https://luxai.cn$publicFeedPath")
        $downloadedManifest = Join-Path $readbackDir 'stable.json'
        $downloadedInstaller = Join-Path $readbackDir $exeName
        $downloadedBlockmap = Join-Path $readbackDir $blockmapName
        $downloadedFeed = Join-Path $readbackDir $feedFileName

        Invoke-StrictPublicDownload -Uri $publicInstallerUrl -ExpectedPath $publicInstallerPath -Destination $downloadedInstaller
        Invoke-StrictPublicDownload -Uri $publicBlockmapUrl -ExpectedPath $publicBlockmapPath -Destination $downloadedBlockmap
        if (
            (Get-Item -LiteralPath $downloadedInstaller).Length -ne (Get-Item -LiteralPath $exePath).Length -or
            (Get-FileHash -LiteralPath $downloadedInstaller -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256
        ) { throw '公网预读的 Stable 安装包大小或 SHA-256 不一致。' }
        if (
            (Get-Item -LiteralPath $downloadedBlockmap).Length -ne (Get-Item -LiteralPath $blockmapPath).Length -or
            (Get-FileHash -LiteralPath $downloadedBlockmap -Algorithm SHA256).Hash.ToLowerInvariant() -ne $blockmapSha256
        ) { throw '公网预读的 Stable blockmap 大小或 SHA-256 不一致。' }
        $downloadedSignature = Get-AuthenticodeSignature -LiteralPath $downloadedInstaller
        if (
            $downloadedSignature.Status -ne 'Valid' -or
            $downloadedSignature.SignerCertificate.GetNameInfo(
                [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
                $false
            ) -ne $publisher -or
            (Get-CertificateSha256 -Certificate $downloadedSignature.SignerCertificate) -ne $expectedCertificateSha256 -or
            -not $downloadedSignature.TimeStamperCertificate
        ) { throw '公网预读的 Stable 安装包 Authenticode、证书指纹或时间戳无效。' }
        Invoke-Checked $signTool @('verify', '/pa', '/all', '/tw', $downloadedInstaller)

        $promoteStableCommand = @"
set -eu
feed='$remoteFeedDir'
manifests='$remoteManifestDir'
staging='$remoteStagingDir'
sudo install -m 0644 "`$staging/$channelManifestName" "`$manifests/.$channelName.json.tmp-$releaseNonce"
sudo mv -Tf "`$manifests/.$channelName.json.tmp-$releaseNonce" "`$manifests/$channelName.json"
sudo install -m 0644 "`$staging/$generatedFeedName" "`$feed/.$feedFileName.tmp-$releaseNonce"
sudo mv -Tf "`$feed/.$feedFileName.tmp-$releaseNonce" "`$feed/$feedFileName"
test "`$(sudo sha256sum "`$manifests/$channelName.json" | awk '{print tolower(`$1)}')" = '$manifestSha256'
test "`$(sudo sha256sum "`$feed/$feedFileName" | awk '{print tolower(`$1)}')" = '$feedSha256'
"@
        Invoke-Checked 'ssh.exe' @('-o', 'BatchMode=yes', $Server, $promoteStableCommand)
        $stablePromoted = $true

        Invoke-StrictPublicDownload -Uri $publicManifestUrl -ExpectedPath $publicManifestPath -Destination $downloadedManifest
        Invoke-StrictPublicDownload -Uri $publicFeedUrl -ExpectedPath $publicFeedPath -Destination $downloadedFeed
        if ((Get-FileHash -LiteralPath $downloadedManifest -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifestSha256) {
            throw '公网 Stable manifest 字节与本地已核验 manifest 的 SHA-256 不一致。'
        }
        if (
            (Get-Item -LiteralPath $downloadedFeed).Length -ne (Get-Item -LiteralPath $generatedFeedPath).Length -or
            (Get-FileHash -LiteralPath $downloadedFeed -Algorithm SHA256).Hash.ToLowerInvariant() -ne $feedSha256
        ) { throw '公网 Stable 更新 feed 大小或 SHA-256 不一致。' }
        try {
            $publicManifest = Get-Content -Raw -LiteralPath $downloadedManifest -Encoding UTF8 | ConvertFrom-Json
        } catch {
            throw "公网 Stable manifest 不是有效 JSON：$($_.Exception.Message)"
        }
        if (
            [int]$publicManifest.schema_version -ne 2 -or
            [string]$publicManifest.platform -ne 'windows' -or
            [string]$publicManifest.channel -ne 'stable' -or
            [string]$publicManifest.availability -ne 'available' -or
            [string]$publicManifest.release_status -ne 'stable_download' -or
            [string]$publicManifest.version -ne $Version -or
            [string]$publicManifest.source_commit -ne $resolvedCommit -or
            [string]$publicManifest.download_url -ne $publicInstallerUrl.AbsoluteUri -or
            [long]$publicManifest.size_bytes -ne (Get-Item -LiteralPath $exePath).Length -or
            [string]$publicManifest.sha256 -ne $sha256 -or
            $publicManifest.code_signed -ne $true -or
            $publicManifest.signing.verified -ne $true -or
            [string]$publicManifest.signing.publisher -ne $publisher -or
            [string]$publicManifest.signing.certificate_sha256 -ne $expectedCertificateSha256 -or
            $publicManifest.signing.timestamp_verified -ne $true -or
            [string]$publicManifest.signing.timestamp_certificate_sha256 -ne $timestampCertificateSha256 -or
            [string]$publicManifest.verification_evidence.sha256 -ne $stableSmokeEvidenceSha256
        ) { throw '公网 Stable manifest 的渠道、提交、签名或验收证据身份不一致。' }
        if (
            [string]$publicManifest.blockmap.name -ne $blockmapName -or
            [string]$publicManifest.blockmap.download_url -ne $publicBlockmapUrl.AbsoluteUri -or
            [long]$publicManifest.blockmap.size_bytes -ne (Get-Item -LiteralPath $blockmapPath).Length -or
            [string]$publicManifest.blockmap.sha256 -ne $blockmapSha256 -or
            [string]$publicManifest.update_feed.name -ne $feedFileName -or
            [string]$publicManifest.update_feed.download_url -ne $publicFeedUrl.AbsoluteUri -or
            [long]$publicManifest.update_feed.size_bytes -ne (Get-Item -LiteralPath $generatedFeedPath).Length -or
            [string]$publicManifest.update_feed.sha256 -ne $feedSha256
        ) { throw '公网 Stable manifest 的 blockmap 或更新 feed 身份不一致。' }
        Write-Host '公网 HTTPS 回读已通过：manifest、安装包、blockmap 与更新 feed 均绑定到同一 Stable 提交。' -ForegroundColor Green
    } else {
        $remoteCommand = @"
set -eu
feed='$remoteFeedDir'
manifests='$remoteManifestDir'
staging='$remoteStagingDir'
test -s "`$staging/$exeName"
test "`$(sha256sum "`$staging/$exeName" | awk '{print tolower(`$1)}')" = '$sha256'
test "`$(sha256sum "`$staging/$blockmapName" | awk '{print tolower(`$1)}')" = '$blockmapSha256'
test "`$(sha256sum "`$staging/$generatedFeedName" | awk '{print tolower(`$1)}')" = '$feedSha256'
test "`$(sha256sum "`$staging/$channelManifestName" | awk '{print tolower(`$1)}')" = '$manifestSha256'
sudo mkdir -p "`$feed" "`$manifests"
sudo install -m 0644 "`$staging/$exeName" "`$feed/$exeName"
sudo install -m 0644 "`$staging/$blockmapName" "`$feed/$blockmapName"
sudo install -m 0644 "`$staging/$channelManifestName" "`$manifests/.$channelName.json.tmp-$releaseNonce"
sudo mv -Tf "`$manifests/.$channelName.json.tmp-$releaseNonce" "`$manifests/$channelName.json"
sudo install -m 0644 "`$staging/$generatedFeedName" "`$feed/.$feedFileName.tmp-$releaseNonce"
sudo mv -Tf "`$feed/.$feedFileName.tmp-$releaseNonce" "`$feed/$feedFileName"
sudo ln -sfn "$exeName" "`$feed/.latest-link-$Version"
sudo mv -Tf "`$feed/.latest-link-$Version" "`$feed/Zhicui-Setup-latest-x64.exe"
sudo install -m 0644 "`$feed/$feedFileName" "`$feed/.latest.yml.tmp-$releaseNonce"
sudo mv -Tf "`$feed/.latest.yml.tmp-$releaseNonce" "`$feed/latest.yml"
test "`$(sudo sha256sum "`$feed/$exeName" | awk '{print tolower(`$1)}')" = '$sha256'
test "`$(sudo sha256sum "`$feed/$blockmapName" | awk '{print tolower(`$1)}')" = '$blockmapSha256'
test "`$(sudo sha256sum "`$feed/$feedFileName" | awk '{print tolower(`$1)}')" = '$feedSha256'
test "`$(sudo sha256sum "`$manifests/$channelName.json" | awk '{print tolower(`$1)}')" = '$manifestSha256'
"@
        Invoke-Checked 'ssh.exe' @('-o', 'BatchMode=yes', $Server, $remoteCommand)
    }
} catch {
    $releaseFailure = $_.Exception.Message
    if ($isStable -and $stableRollbackPrepared) {
        $rollbackStableCommand = @"
set -eu
feed='$remoteFeedDir'
manifests='$remoteManifestDir'
rollback='$remoteStagingDir/rollback'
feed_state="`$(cat "`$rollback/feed.state")"
manifest_state="`$(cat "`$rollback/manifest.state")"
if [ "`$feed_state" = present ]; then
  expected="`$(cat "`$rollback/feed.sha256")"
  test "`$(sudo sha256sum "`$rollback/feed.previous" | awk '{print tolower(`$1)}')" = "`$expected"
  sudo install -m 0644 "`$rollback/feed.previous" "`$feed/.$feedFileName.rollback-$releaseNonce"
  sudo mv -Tf "`$feed/.$feedFileName.rollback-$releaseNonce" "`$feed/$feedFileName"
  test "`$(sudo sha256sum "`$feed/$feedFileName" | awk '{print tolower(`$1)}')" = "`$expected"
else
  sudo rm -f -- "`$feed/$feedFileName"
  ! sudo test -e "`$feed/$feedFileName"
fi
if [ "`$manifest_state" = present ]; then
  expected="`$(cat "`$rollback/manifest.sha256")"
  test "`$(sudo sha256sum "`$rollback/manifest.previous" | awk '{print tolower(`$1)}')" = "`$expected"
  sudo install -m 0644 "`$rollback/manifest.previous" "`$manifests/.$channelName.json.rollback-$releaseNonce"
  sudo mv -Tf "`$manifests/.$channelName.json.rollback-$releaseNonce" "`$manifests/$channelName.json"
  test "`$(sudo sha256sum "`$manifests/$channelName.json" | awk '{print tolower(`$1)}')" = "`$expected"
else
  sudo rm -f -- "`$manifests/$channelName.json"
  ! sudo test -e "`$manifests/$channelName.json"
fi
"@
        try {
            Invoke-Checked 'ssh.exe' @('-o', 'BatchMode=yes', $Server, $rollbackStableCommand)
        } catch {
            throw "Stable Windows 发布失败，且 stable.yml/stable.json 自动回滚未通过；请立即人工关闭该通道。原始错误：$releaseFailure"
        }
        throw "Stable Windows 发布失败，已恢复上一版 stable.yml/stable.json：$releaseFailure"
    }
    throw
} finally {
    if ($readbackDir) {
        $resolvedReadbackDir = [System.IO.Path]::GetFullPath($readbackDir)
        if (
            $resolvedReadbackDir.StartsWith($systemTemp, [StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $resolvedReadbackDir) -like 'zhicui-stable-readback-*' -and
            [System.IO.Directory]::Exists($resolvedReadbackDir)
        ) { [System.IO.Directory]::Delete($resolvedReadbackDir, $true) }
    }
    & ssh.exe -o BatchMode=yes $Server $cleanupRemoteCommand *> $null
}

Write-Host "发布完成：https://luxai.cn/download/windows/$feedFileName" -ForegroundColor Green
Write-Host "版本化安装包：https://luxai.cn/download/windows/$exeName" -ForegroundColor Green
