param(
    [ValidateRange(1, 65535)]
    [int]$Port = 11223,
    [switch]$Stop,
    [switch]$PassThru
)

$ErrorActionPreference = 'Stop'
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'Zhicui\yutto-sidecar'
$yuttoPath = Join-Path $runtimeRoot '.venv\Scripts\yutto.exe'
$tokenPath = Join-Path $runtimeRoot 'server.token'
$pidPath = Join-Path $env:TEMP "zhicui-yutto-sidecar-$Port.pid"
$logRoot = Join-Path $runtimeRoot 'logs'

function Test-LoopbackPort {
    param([int]$TargetPort)
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync('127.0.0.1', $TargetPort)
        return $task.Wait(500) -and $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

if ($Stop) {
    if (Test-Path -LiteralPath $pidPath) {
        $savedPid = [int](Get-Content -LiteralPath $pidPath -Raw)
        $process = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
        if ($process) { Stop-Process -Id $savedPid -Force }
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $yuttoPath)) {
    throw 'Local yutto is missing. Run scripts\install-yutto-sidecar.ps1 first.'
}

New-Item -ItemType Directory -Force -Path $runtimeRoot, $logRoot | Out-Null
if (-not (Test-Path -LiteralPath $tokenPath)) {
    $pythonPath = Join-Path $runtimeRoot '.venv\Scripts\python.exe'
    $token = (& $pythonPath -c 'import secrets; print(secrets.token_urlsafe(48))').Trim()
    [IO.File]::WriteAllText($tokenPath, $token, [Text.UTF8Encoding]::new($false))
}

$env:YUTTO_CATALOG_ENABLED = 'true'
$env:YUTTO_CATALOG_URL = "ws://127.0.0.1:$Port"
$env:YUTTO_CATALOG_TOKEN_FILE = $tokenPath

if (Test-LoopbackPort -TargetPort $Port) {
    Write-Host "The Bilibili catalog connector is already running on port $Port."
    return
}

$outLog = Join-Path $logRoot 'sidecar.out.log'
$errorLog = Join-Path $logRoot 'sidecar.error.log'
$process = Start-Process `
    -FilePath $yuttoPath `
    -ArgumentList @(
        'serve',
        '--host', '127.0.0.1',
        '--port', "$Port",
        '--token-file', $tokenPath,
        '--download-root', (Join-Path $runtimeRoot 'blocked-downloads'),
        '--tmp-root', (Join-Path $runtimeRoot 'tmp'),
        '--max-fetch-workers', '16',
        # yutto 2.2.0 validates its internal default request (8 workers) at
        # startup. Zhicui only calls resolve.start and never download.start.
        '--max-download-workers', '8',
        '--task-limit', '64',
        '--jobs', '1'
    ) `
    -WorkingDirectory $runtimeRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errorLog `
    -PassThru

Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ascii
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    if (Test-LoopbackPort -TargetPort $Port) {
        Write-Host "The Bilibili catalog connector started on 127.0.0.1:$Port."
        if ($PassThru) { return $process }
        return
    }
    if ($process.HasExited) { break }
    Start-Sleep -Milliseconds 400
}

if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
throw "The Bilibili catalog connector failed to start. See $errorLog"
