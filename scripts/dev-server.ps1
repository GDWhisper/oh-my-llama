<#
.SYNOPSIS
    Manage the oh-my-llama Tauri dev server: start / stop / restart.

.DESCRIPTION
    `npm run tauri dev` starts a Vite dev server on -Port (default 6060) plus the
    Rust/Tauri backend. The dev and main worktrees share node_modules, so they
    share the same Vite port — only one dev server may run at a time.

    restart detects whatever holds the port, kills it (whole process tree), then
    starts a fresh instance.

.PARAMETER Action
    start   - launch npm run tauri dev (refuses if the port is already in use)
    stop    - kill whatever holds the port (whole process tree)
    restart - stop, then start

.PARAMETER Dir
    Project directory. Defaults to the current directory.

.PARAMETER Port
    Dev port to manage. Default 6060.

.EXAMPLE
    .\scripts\dev-server.ps1 start
    .\scripts\dev-server.ps1 stop
    .\scripts\dev-server.ps1 restart
    .\scripts\dev-server.ps1 restart -Dir F:\llama_run\llama-launcher-dev
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('start', 'stop', 'restart')]
    [string] $Action,

    [string] $Dir = '.',

    [int] $Port = 6060
)

$ErrorActionPreference = 'Stop'

function Get-PortOwnerPid {
    param([int] $Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
        Where-Object { $_.State -eq 'Listen' }
    if (-not $conn) { return $null }
    return ($conn | Select-Object -First 1).OwningProcess
}

function Stop-DevServer {
    param([int] $Port)
    $ownerPid = Get-PortOwnerPid -Port $Port
    if (-not $ownerPid) {
        Write-Host "Port $($Port): nothing listening - dev server already stopped." -ForegroundColor Yellow
        return $false
    }
    $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    $name = if ($proc) { $proc.ProcessName } else { 'unknown' }
    Write-Host "Port $($Port) held by PID $ownerPid ($name). Killing process tree..." -ForegroundColor Cyan
    # /T kills the whole tree: cmd -> npm -> tauri cli -> cargo -> app window
    & taskkill.exe /T /F /PID $ownerPid | Out-Null
    Start-Sleep -Seconds 2
    $still = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
        Where-Object { $_.State -eq 'Listen' }
    if ($still) {
        Write-Warning "Port $($Port) STILL in use after kill - manual check required."
        return $false
    }
    Write-Host "Port $($Port) freed." -ForegroundColor Green
    return $true
}

function Start-DevServer {
    param([string] $Dir, [int] $Port)
    $absDir = (Resolve-Path $Dir).Path
    $existing = Get-PortOwnerPid -Port $Port
    if ($existing) {
        $p = Get-Process -Id $existing -ErrorAction SilentlyContinue
        Write-Error "Port $($Port) already in use by PID $existing ($($p.ProcessName)). Use 'restart' or 'stop' first."
        exit 1
    }
    Write-Host "Starting dev server in $absDir ..." -ForegroundColor Cyan
    # Detached cmd so your terminal stays usable; logs show in the new window.
    $cmd = "cd /d `"$absDir`" && npm run tauri dev"
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -WindowStyle Normal
    Write-Host "Dev server launching on port $Port (npm run tauri dev)." -ForegroundColor Green
}

switch ($Action) {
    'start'   { Start-DevServer -Dir $Dir -Port $Port }
    'stop'    { Stop-DevServer -Port $Port | Out-Null }
    'restart' {
        Write-Host '== restart: stopping first ==' -ForegroundColor Cyan
        Stop-DevServer -Port $Port | Out-Null
        Start-Sleep -Seconds 1
        Start-DevServer -Dir $Dir -Port $Port
    }
}
