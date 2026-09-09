[CmdletBinding()]
param(
    # 可额外核对一份实际官方缓存；默认只运行本地合成夹具。
    [string]$OfficialZipPath = ''
)

$ErrorActionPreference = 'Stop'
$releaseScript = Join-Path $PSScriptRoot 'release-desktop.ps1'
$parseErrors = $null
$tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($releaseScript, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw "发行脚本语法错误：$parseErrors" }
$helper = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Resolve-ElectronReleaseZip' }, $true)
if (-not $helper) { throw '发行脚本缺少 ZIP 校验函数。' }
# 仅载入受测函数，不执行发行脚本顶层的构建、远程访问或发布。
. ([scriptblock]::Create($helper.Extent.Text))

function Assert-Rejected {
    param([scriptblock]$Action, [string]$Pattern)
    try { & $Action | Out-Null } catch {
        if ($_.Exception.Message -notmatch $Pattern) { throw }
        return
    }
    throw "预期拒绝输入：$Pattern"
}

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("zhicui-electron-input-test-" + [Guid]::NewGuid().ToString('N'))
$fixtureDesktop = Join-Path $fixtureRoot 'desktop'
$electronDirectory = Join-Path $fixtureDesktop 'node_modules/electron'
$fixtureZip = Join-Path $fixtureRoot 'electron-v43.2.0-win32-x64.zip'
try {
    New-Item -ItemType Directory -Path $electronDirectory -Force | Out-Null
    [System.IO.File]::WriteAllText($fixtureZip, '仅用于 SHA256 输入校验的合成夹具，不是可运行的 Electron。')
    $fixtureHash = (Get-FileHash -LiteralPath $fixtureZip -Algorithm SHA256).Hash.ToLowerInvariant()
    $lockPath = Join-Path $fixtureDesktop 'package-lock.json'
    $packagePath = Join-Path $electronDirectory 'package.json'
    $checksumPath = Join-Path $electronDirectory 'checksums.json'
    [System.IO.File]::WriteAllText($lockPath, '{"packages":{"":{"name":"test-desktop"},"node_modules/electron":{"version":"43.2.0"}}}')
    [System.IO.File]::WriteAllText($packagePath, '{"version":"43.2.0"}')
    [System.IO.File]::WriteAllText($checksumPath, (@{ 'electron-v43.2.0-win32-x64.zip' = $fixtureHash } | ConvertTo-Json))

    if ($null -ne (Resolve-ElectronReleaseZip -ZipPath '' -DesktopDirectory $fixtureDesktop)) { throw '可选参数为空时应保持默认构建路径。' }
    $accepted = Resolve-ElectronReleaseZip -ZipPath $fixtureZip -DesktopDirectory $fixtureDesktop
    if ($accepted.version -ne '43.2.0' -or $accepted.sha256 -cne $fixtureHash -or $accepted.path -ne $fixtureZip) { throw '正确版本与 SHA256 未通过。' }

    # 从实际发行脚本 AST 提取子调用参数，确认值原样进入 InternalWorktree。
    $assignment = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$childParameters' }, $true)
    if (-not $assignment) { throw '缺少隔离构建参数。' }
    $ElectronZipPath = $accepted.path
    $forwarded = & ([scriptblock]::Create($assignment.Right.Extent.Text))
    if ($forwarded.ElectronZipPath -ne $accepted.path -or $forwarded.InternalWorktree -ne $true) { throw 'Electron ZIP 参数未传播到隔离构建。' }
    $parameterNames = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
    if ($parameterNames -notcontains 'ElectronZipPath') { throw '缺少公开 ElectronZipPath 参数。' }

    Assert-Rejected { Resolve-ElectronReleaseZip -ZipPath $fixtureRoot -DesktopDirectory $fixtureDesktop } '必须是官方 ZIP 文件'
    $wrongName = Join-Path $fixtureRoot 'electron-v43.4.0-win32-x64.zip'
    Copy-Item -LiteralPath $fixtureZip -Destination $wrongName
    Assert-Rejected { Resolve-ElectronReleaseZip -ZipPath $wrongName -DesktopDirectory $fixtureDesktop } '文件名必须'
    [System.IO.File]::WriteAllText($packagePath, '{"version":"43.4.0"}')
    Assert-Rejected { Resolve-ElectronReleaseZip -ZipPath $fixtureZip -DesktopDirectory $fixtureDesktop } '版本与 package-lock.json 不一致'
    [System.IO.File]::WriteAllText($packagePath, '{"version":"43.2.0"}')
    [System.IO.File]::WriteAllText($checksumPath, '{}')
    Assert-Rejected { Resolve-ElectronReleaseZip -ZipPath $fixtureZip -DesktopDirectory $fixtureDesktop } '有效官方 SHA256'
    [System.IO.File]::WriteAllText($checksumPath, (@{ 'electron-v43.2.0-win32-x64.zip' = ('0' * 64) } | ConvertTo-Json))
    Assert-Rejected { Resolve-ElectronReleaseZip -ZipPath $fixtureZip -DesktopDirectory $fixtureDesktop } 'SHA256 与锁定包'
    [System.IO.File]::WriteAllText($lockPath, '{"packages":{}}')
    Assert-Rejected { Resolve-ElectronReleaseZip -ZipPath $fixtureZip -DesktopDirectory $fixtureDesktop } '锁定 Electron 版本'

    if ($OfficialZipPath) {
        $actual = Resolve-ElectronReleaseZip -ZipPath $OfficialZipPath -DesktopDirectory (Join-Path $PSScriptRoot '../desktop')
        Write-Host "实际官方 ZIP 验证通过：$($actual.name) SHA256 $($actual.sha256)"
    }
    Write-Host 'Electron 发行输入验证通过：可选参数、隔离传播、版本与 SHA256 校验、错误输入拒绝。'
} finally {
    # 仅清理本次创建的临时夹具；验证绝对路径边界后仍使用同一 PowerShell 删除。
    $resolvedFixture = [System.IO.Path]::GetFullPath($fixtureRoot)
    $tempBoundary = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedFixture.StartsWith($tempBoundary, [System.StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolvedFixture) -notlike 'zhicui-electron-input-test-*') {
        throw '临时夹具清理路径越界。'
    }
    if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
}
