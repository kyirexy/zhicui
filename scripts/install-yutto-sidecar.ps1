param()

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'Zhicui\yutto-sidecar'
$revision = 'ba90a95bd89e416059ee5559b52197531d5d8998'
$sourceRoot = Join-Path $runtimeRoot "source\$revision"
$venvRoot = Join-Path $runtimeRoot '.venv'
$pythonPath = Join-Path $venvRoot 'Scripts\python.exe'
$yuttoPath = Join-Path $venvRoot 'Scripts\yutto.exe'
$catalogPatch = Join-Path $repoRoot 'deploy\yutto-sidecar\zhicui-catalog-fields.patch'

function Resolve-RequiredCommand {
    param([string]$Name, [string]$Hint)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "$Name is unavailable. $Hint"
    }
    return $command.Source
}

$gitPath = Resolve-RequiredCommand 'git.exe' 'Install Git first.'
$uvPath = Resolve-RequiredCommand 'uv.exe' 'Install uv first.'

New-Item -ItemType Directory -Force -Path (Split-Path $sourceRoot) | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot '.git'))) {
    & $gitPath clone --no-checkout https://github.com/yutto-dev/yutto.git $sourceRoot
    if ($LASTEXITCODE -ne 0) { throw 'Failed to clone yutto source.' }
    & $gitPath -C $sourceRoot checkout $revision
    if ($LASTEXITCODE -ne 0) { throw 'Failed to checkout the pinned yutto revision.' }
}

$actualRevision = (& $gitPath -C $sourceRoot rev-parse HEAD).Trim()
if ($actualRevision -ne $revision) {
    throw 'The local yutto source is not at the pinned revision.'
}

& $gitPath -C $sourceRoot apply --reverse --check $catalogPatch 2>$null
if ($LASTEXITCODE -eq 0) {
    & $gitPath -C $sourceRoot apply --reverse $catalogPatch
    if ($LASTEXITCODE -ne 0) { throw 'Failed to restore the catalog patch.' }
}
& $gitPath -C $sourceRoot apply --check $catalogPatch
if ($LASTEXITCODE -ne 0) { throw 'The catalog patch does not match the pinned revision.' }
& $gitPath -C $sourceRoot apply $catalogPatch
if ($LASTEXITCODE -ne 0) { throw 'Failed to apply the catalog patch.' }

$needsInstall = $true
if (Test-Path -LiteralPath $yuttoPath) {
    $installedVersion = (& $yuttoPath --version 2>$null).Trim()
    $needsInstall = $installedVersion -ne 'yutto 2.2.0'
}

if ($needsInstall -and -not (Test-Path -LiteralPath $pythonPath)) {
    & $uvPath venv --python 3.12 $venvRoot
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create the isolated yutto environment.' }
}

if ($needsInstall) {
    $rustToolchains = @(& rustup toolchain list 2>$null)
    $rustToolchain = @(
        '1.92-x86_64-pc-windows-msvc',
        '1.95.0-x86_64-pc-windows-msvc',
        '1.95-x86_64-pc-windows-msvc'
    ) | Where-Object { $rustToolchains -match [regex]::Escape($_) } | Select-Object -First 1
    if (-not $rustToolchain) {
        throw 'A Rust MSVC toolchain (1.85 or newer) is required.'
    }

    $previousRustToolchain = $env:RUSTUP_TOOLCHAIN
    $env:RUSTUP_TOOLCHAIN = $rustToolchain
    try {
        & $uvPath pip install --python $pythonPath $sourceRoot
        if ($LASTEXITCODE -ne 0) { throw 'Failed to build and install yutto.' }
    } finally {
        $env:RUSTUP_TOOLCHAIN = $previousRustToolchain
    }
}

if (-not (Test-Path -LiteralPath $yuttoPath)) {
    throw 'The yutto executable was not generated.'
}
$version = (& $yuttoPath --version).Trim()
if ($version -ne 'yutto 2.2.0') {
    throw "Unexpected yutto version: $version"
}

Copy-Item -LiteralPath (Join-Path $sourceRoot 'LICENSE') -Destination (Join-Path $runtimeRoot 'LICENSE.yutto-GPL-3.0') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'deploy\yutto-sidecar\SOURCE-NOTICE.md') -Destination (Join-Path $runtimeRoot 'SOURCE-NOTICE.md') -Force
Copy-Item -LiteralPath $catalogPatch -Destination (Join-Path $runtimeRoot 'zhicui-catalog-fields.patch') -Force

Write-Host "yutto 2.2.0 is installed at $runtimeRoot"
