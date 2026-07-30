param(
    [ValidateRange(1, 65535)]
    [int]$Port = 9000,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$downloaderRoot = Get-ChildItem -LiteralPath $repoRoot -Directory |
    ForEach-Object {
        $candidate = Join-Path $_.FullName 'douyin-downloader'
        if (Test-Path -LiteralPath (Join-Path $candidate 'run.py')) {
            $candidate
        }
    } |
    Select-Object -First 1

if (-not $downloaderRoot) {
    Write-Error 'Local douyin-downloader directory was not found.'
    exit 1
}

$pythonPath = Join-Path $downloaderRoot '.venv\Scripts\python.exe'
$pidPath = Join-Path $env:TEMP "zhicui-douyin-sidecar-$Port.pid"
$healthUrl = "http://127.0.0.1:$Port/api/v1/health"

function Test-DouyinSidecar {
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
        return $response.status -eq 'ok'
    } catch {
        return $false
    }
}

if ($Stop) {
    if (Test-Path -LiteralPath $pidPath) {
        $savedPid = [int](Get-Content -LiteralPath $pidPath -Raw)
        $process = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
        if ($process) {
            Stop-Process -Id $savedPid -Force
        }
        Remove-Item -LiteralPath $pidPath -Force
    }
    exit 0
}

if (Test-DouyinSidecar) {
    Write-Host "Douyin service is already running on port $Port."
    exit 0
}

if (-not (Test-Path -LiteralPath $pythonPath)) {
    Write-Error "Local Douyin service is not installed: $pythonPath"
    exit 1
}

$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$process = Start-Process `
    -FilePath $pythonPath `
    -ArgumentList @(
        'run.py',
        '--serve',
        '--serve-host',
        '127.0.0.1',
        '--serve-port',
        "$Port"
    ) `
    -WorkingDirectory $downloaderRoot `
    -WindowStyle Hidden `
    -PassThru

Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ascii

$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
    if (Test-DouyinSidecar) {
        Write-Host "Douyin service started on port $Port."
        exit 0
    }
    if ($process.HasExited) {
        break
    }
    Start-Sleep -Milliseconds 400
}

if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
}
Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
Write-Error "Douyin service failed to start on port $Port."
exit 1
