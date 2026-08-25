param(
    [ValidateRange(1, 65535)]
    [int]$BackendPort = 8000,

    [ValidateRange(1, 65535)]
    [int]$FrontendPort = 3003,

    [switch]$Install,

    [switch]$KeepServices
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $repoRoot 'backend'
$frontendRoot = Join-Path $repoRoot 'frontend'
$desktopRoot = Join-Path $repoRoot 'desktop'
$logRoot = Join-Path $repoRoot '.tmp\desktop-dev'

$backendUrl = "http://127.0.0.1:$BackendPort"
$frontendUrl = "http://localhost:$FrontendPort"
$backendHealthUrl = "$backendUrl/api/health"
$frontendHealthUrl = "$frontendUrl/harness"

$backendProcess = $null
$frontendProcess = $null
$yuttoProcess = $null
$exitCode = 0

function Write-Step {
    param(
        [string]$Label,
        [string]$Message
    )

    Write-Host "[$Label] " -ForegroundColor DarkGreen -NoNewline
    Write-Host $Message
}

function Resolve-RequiredCommand {
    param(
        [string]$Name,
        [string]$InstallHint
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "未找到 $Name。$InstallHint"
    }
    return $command.Source
}

function Test-HttpEndpoint {
    param([string]$Url)

    try {
        $response = Invoke-WebRequest `
            -Uri $Url `
            -Method Get `
            -UseBasicParsing `
            -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
    } catch {
        return $false
    }
}

function Wait-ForEndpoint {
    param(
        [string]$Name,
        [string]$Url,
        [System.Diagnostics.Process]$Process,
        [string]$ErrorLog,
        [int]$TimeoutSeconds = 60
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-HttpEndpoint -Url $Url) {
            Write-Step '就绪' "$Name 已启动：$Url"
            return
        }
        if ($Process -and $Process.HasExited) {
            throw "$Name 启动失败。请查看日志：$ErrorLog"
        }
        Start-Sleep -Milliseconds 500
    }

    throw "$Name 启动超时。请查看日志：$ErrorLog"
}

function Invoke-NpmInstall {
    param(
        [string]$NpmPath,
        [string]$WorkingDirectory,
        [string]$Name
    )

    Write-Step '安装' "正在安装 $Name 依赖"
    Push-Location $WorkingDirectory
    try {
        & $NpmPath install
        if ($LASTEXITCODE -ne 0) {
            throw "$Name 依赖安装失败"
        }
    } finally {
        Pop-Location
    }
}

function Stop-StartedProcessTree {
    param(
        [System.Diagnostics.Process]$Process,
        [string]$Name
    )

    if (-not $Process -or $Process.HasExited) {
        return
    }

    Write-Step '停止' "正在关闭本次启动的 $Name"
    & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
}

try {
    Write-Host ''
    Write-Host '  ┌──────────────────────────────┐' -ForegroundColor DarkGreen
    Write-Host '  │   知萃桌面端 · 一键开发启动   │' -ForegroundColor DarkGreen
    Write-Host '  └──────────────────────────────┘' -ForegroundColor DarkGreen
    Write-Host ''

    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

    $npmPath = Resolve-RequiredCommand `
        -Name 'npm.cmd' `
        -InstallHint '请先安装 Node.js 20 或更高版本。'

    $venvPython = Join-Path $backendRoot '.venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $venvPython) {
        $pythonPath = $venvPython
    } else {
        $pythonPath = Resolve-RequiredCommand `
            -Name 'python.exe' `
            -InstallHint '请先安装 Python 3.11 或 3.12。'
    }

    if ($Install) {
        Write-Step '安装' '正在安装后端依赖'
        & $pythonPath -m pip install -r (Join-Path $backendRoot 'requirements.txt')
        if ($LASTEXITCODE -ne 0) {
            throw '后端依赖安装失败'
        }
    }

    if ($Install -or -not (Test-Path -LiteralPath (Join-Path $frontendRoot 'node_modules'))) {
        Invoke-NpmInstall `
            -NpmPath $npmPath `
            -WorkingDirectory $frontendRoot `
            -Name '网页端'
    }

    if ($Install -or -not (Test-Path -LiteralPath (Join-Path $desktopRoot 'node_modules'))) {
        Invoke-NpmInstall `
            -NpmPath $npmPath `
            -WorkingDirectory $desktopRoot `
            -Name '桌面端'
    }

    $yuttoRuntime = Join-Path $env:LOCALAPPDATA 'Zhicui\yutto-sidecar\.venv\Scripts\yutto.exe'
    if ($Install -or -not (Test-Path -LiteralPath $yuttoRuntime)) {
        Write-Step '安装' '正在准备 B站全部作品连接器（首次安装需要几分钟）'
        & (Join-Path $PSScriptRoot 'install-yutto-sidecar.ps1')
    }
    Write-Step '启动' 'B站全部作品连接器'
    $yuttoProcess = & (Join-Path $PSScriptRoot 'start-yutto-sidecar.ps1') -PassThru

    if (Test-HttpEndpoint -Url $backendHealthUrl) {
        Write-Step '复用' "后端已经运行：$backendUrl"
    } else {
        $backendOutLog = Join-Path $logRoot 'backend.out.log'
        $backendErrorLog = Join-Path $logRoot 'backend.error.log'
        Write-Step '启动' "后端：$backendUrl"
        $backendProcess = Start-Process `
            -FilePath $pythonPath `
            -ArgumentList @(
                'run.py',
                '--host',
                '127.0.0.1',
                '--port',
                "$BackendPort"
            ) `
            -WorkingDirectory $backendRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $backendOutLog `
            -RedirectStandardError $backendErrorLog `
            -PassThru

        Wait-ForEndpoint `
            -Name '后端' `
            -Url $backendHealthUrl `
            -Process $backendProcess `
            -ErrorLog $backendErrorLog
    }

    if (Test-HttpEndpoint -Url $frontendHealthUrl) {
        Write-Step '复用' "网页端已经运行：$frontendUrl"
    } else {
        $frontendOutLog = Join-Path $logRoot 'frontend.out.log'
        $frontendErrorLog = Join-Path $logRoot 'frontend.error.log'
        Write-Step '启动' "网页端：$frontendUrl"
        $frontendProcess = Start-Process `
            -FilePath $npmPath `
            -ArgumentList @(
                'run',
                'dev',
                '--',
                '-p',
                "$FrontendPort"
            ) `
            -WorkingDirectory $frontendRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $frontendOutLog `
            -RedirectStandardError $frontendErrorLog `
            -PassThru

        Wait-ForEndpoint `
            -Name '网页端' `
            -Url $frontendHealthUrl `
            -Process $frontendProcess `
            -ErrorLog $frontendErrorLog
    }

    Write-Step '启动' '正在打开 Electron 桌面端'
    Write-Host "        桌面端地址：$frontendUrl" -ForegroundColor DarkGray
    Write-Host '        关闭桌面窗口后，本脚本会自动结束。' -ForegroundColor DarkGray
    Write-Host ''

    $previousDesktopUrl = $env:ZHICUI_DESKTOP_URL
    $env:ZHICUI_DESKTOP_URL = $frontendUrl
    Push-Location $desktopRoot
    try {
        & $npmPath run dev
        if ($LASTEXITCODE -ne 0) {
            throw "Electron 桌面端退出，错误码：$LASTEXITCODE"
        }
    } finally {
        Pop-Location
        $env:ZHICUI_DESKTOP_URL = $previousDesktopUrl
    }
} catch {
    $exitCode = 1
    Write-Host ''
    Write-Host "[失败] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "日志目录：$logRoot" -ForegroundColor DarkGray
} finally {
    if (-not $KeepServices) {
        Stop-StartedProcessTree -Process $frontendProcess -Name '网页端'
        Stop-StartedProcessTree -Process $backendProcess -Name '后端'
        Stop-StartedProcessTree -Process $yuttoProcess -Name 'B站目录连接器'
    } else {
        Write-Step '保留' '后端和网页端继续在后台运行'
    }
}

exit $exitCode
