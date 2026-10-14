<#
.SYNOPSIS
    Manage the oh-my-llama Tauri dev server: start / stop / restart.

.DESCRIPTION
    `npm run tauri dev` starts a Vite dev server on -Port (default 6060) plus the
    Rust/Tauri backend. The dev and main worktrees share node_modules, so they
    share the same Vite port — only one dev server may run at a time.

    restart stops the running dev session (the whole process tree, not just the
    Vite process), then starts a fresh instance.

.PARAMETER Action
    start   - launch npm run tauri dev (refuses if the port is already in use)
    stop    - kill the whole dev session (see Stop-DevServer)
    restart - stop, then start

.PARAMETER Dir
    Project directory. Defaults to this script's repo root (NOT your current directory),
    so the script works when invoked by full path from anywhere.

.PARAMETER Port
    Dev port to manage. Default 6060.

.EXAMPLE
    .\scripts\dev-server.ps1 start
    .\scripts\dev-server.ps1 stop
    .\scripts\dev-server.ps1 restart
    .\scripts\dev-server.ps1 restart -Dir F:\llama_run\llama-launcher-dev

.NOTES
    本文件含中文注释，必须存成「UTF-8 with BOM」。Windows PowerShell 5.1 读无 BOM 的
    UTF-8 会退回系统代码页（中文机上是 GBK），把中文注释解码错、进而合并行号，
    表现为莫名其妙的运行时错误（2026-10-14 实测：CimInstance 不包含 op_Addition）。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('start', 'stop', 'restart')]
    [string] $Action,

    [string] $Dir = '',

    [int] $Port = 6060
)

$ErrorActionPreference = 'Stop'

# Resolve the repo root from this script's own location. The old '.' default followed the
# caller's current directory, so invoking by full path from elsewhere ran npm in the wrong
# place and the child window died before you could read it.
if (-not $Dir) {
    $Dir = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { '.' }
}

function Get-PortOwnerPid {
    param([int] $Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
        Where-Object { $_.State -eq 'Listen' }
    if (-not $conn) { return $null }
    return [int]($conn | Select-Object -First 1).OwningProcess
}

function Get-ProcessMap {
    # 全量进程快照，键为 int 化后的 ProcessId。祖先与后代查询都走这张表，
    # 不在循环里反复调 Get-CimInstance。
    $map = @{}
    foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        $map[[int]$p.ProcessId] = $p
    }
    return $map
}

function Get-AncestorIds {
    param([int] $ProcessId, $Map)
    # 自己 + 祖先链，自己在前。32 层上限只防 PID 复用成环；正常链路不到 10 层。
    $ids = New-Object System.Collections.Generic.List[int]
    $cur = $ProcessId
    for ($i = 0; $i -lt 32 -and $cur -gt 0; $i++) {
        $ids.Add($cur)
        if (-not $Map.ContainsKey($cur)) { break }
        $cur = [int]$Map[$cur].ParentProcessId
    }
    return $ids
}

function Get-DescendantIds {
    param([int] $RootProcessId, $Map)
    # 反查祖先链经过 $RootProcessId 的全部进程。
    # 不能只靠 taskkill /T：它逐层杀，父进程一死子进程就被系统改父，
    # 实测整条漏掉 cargo 与 oh-my-llama.exe 那条分支（2026-10-14）。
    $ids = New-Object System.Collections.Generic.List[int]
    foreach ($id in $Map.Keys) {
        if ($id -eq $RootProcessId) { continue }
        $cur = $id
        for ($i = 0; $i -lt 32; $i++) {
            if (-not $Map.ContainsKey($cur)) { break }
            $parent = [int]$Map[$cur].ParentProcessId
            if ($parent -le 0) { break }
            if ($parent -eq $RootProcessId) { $ids.Add($id); break }
            $cur = $parent
        }
    }
    return $ids
}

function Kill-Tree {
    param([int] $ProcessId)
    # taskkill 对已经不在的进程会往 stderr 写一行。脚本级 $ErrorActionPreference='Stop'
    # 会把原生命令的 stderr 变成终止性错误，所以这里临时放宽，再把两路流合并丢弃。
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & taskkill.exe /T /F /PID $ProcessId 2>&1 | Out-Null
    }
    finally {
        $ErrorActionPreference = $prev
    }
}

function Stop-DevServer {
    param([string] $Dir, [int] $Port)
    $absDir = $null
    if ($Dir -and (Test-Path $Dir)) { $absDir = (Resolve-Path $Dir).Path }

    $map = Get-ProcessMap
    # 自己与自己的祖先链。挑 dev 会话根时必须排除它们：stop 常在另一个终端里跑，
    # 误把调用方终端选成根会连终端一起杀掉。
    $protected = Get-AncestorIds -ProcessId $PID -Map $map

    # 要整树杀掉的 dev 会话根。注意不是端口占用者——那是 vite，只是会话的叶子：
    # vite 挂在 tauri CLI 下，cargo 与 app 挂在 tauri CLI 的另一个分支上。
    # 所以从端口占用者沿祖先链上溯，取最顶端仍带 'tauri dev' 的进程，
    # 即 start 时 Start-Process 起的那个 cmd。
    $roots = New-Object System.Collections.Generic.List[int]
    $ownerPid = Get-PortOwnerPid -Port $Port

    if ($ownerPid) {
        $rootId = 0
        foreach ($id in (Get-AncestorIds -ProcessId $ownerPid -Map $map)) {
            $p = $map[$id]
            if ($p.CommandLine -and
                $p.CommandLine -match 'tauri\s+dev' -and
                ($protected -notcontains $id)) {
                $rootId = $id
            }
        }
        if ($rootId -gt 0) {
            $roots.Add($rootId)
        }
        else {
            $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
            $name = if ($proc) { $proc.ProcessName } else { 'unknown' }
            Write-Warning "Port $Port is held by PID $ownerPid ($name), which is not part of a 'tauri dev' session. Killing that process tree only."
            Kill-Tree -ProcessId $ownerPid
        }
    }

    if ($absDir) {
        # vite 先死而 app 还在时，端口已无监听，按端口反查不到会话。按「命令行同时含
        # 'tauri dev' 与本仓库目录」直接找出 start 时起的那个 cmd，它同样是会话根。
        # 顺带清掉停在 || pause 上、其实早已退出的旧窗口。
        foreach ($p in $map.Values) {
            if ($p.CommandLine -and
                $p.CommandLine -match 'tauri\s+dev' -and
                $p.CommandLine -like "*$absDir*" -and
                ($protected -notcontains [int]$p.ProcessId)) {
                $roots.Add([int]$p.ProcessId)
            }
        }
    }

    if ($roots.Count -eq 0) {
        Write-Host "Port $($Port): nothing listening - dev server already stopped." -ForegroundColor Yellow
        return $false
    }

    foreach ($r in ($roots | Select-Object -Unique)) {
        $pids = New-Object System.Collections.Generic.List[int]
        $pids.Add($r)
        foreach ($d in (Get-DescendantIds -RootProcessId $r -Map $map)) {
            $pids.Add($d)
        }
        Write-Host "Port $Port dev session: killing $($pids.Count) process(es) in the tree rooted at PID $r ..." -ForegroundColor Cyan
        foreach ($p in ($pids | Select-Object -Unique)) {
            Kill-Tree -ProcessId $p
        }
    }

    Start-Sleep -Seconds 2
    $still = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
        Where-Object { $_.State -eq 'Listen' }
    if ($still) {
        Write-Warning "Port $($Port) STILL in use after kill - manual check required."
        return $false
    }
    $leftover = @(Get-CimInstance Win32_Process -Filter "Name='oh-my-llama.exe'" -ErrorAction SilentlyContinue)
    if ($leftover.Count -gt 0) {
        Write-Warning "Port freed, but oh-my-llama.exe still runs (PID $(($leftover | ForEach-Object { $_.ProcessId }) -join ', ')). It may be the installed release build - leaving it alone."
    }
    Write-Host "Port $($Port) freed." -ForegroundColor Green
    return $true
}

function Start-DevServer {
    param([string] $Dir, [int] $Port)
    $absDir = (Resolve-Path $Dir).Path
    # Pre-flight the directory: without this, npm fails inside the detached window and
    # closes it before the error is readable, leaving only the "launching" line behind.
    $pkg = Join-Path $absDir 'package.json'
    if (-not (Test-Path $pkg)) {
        Write-Error "No package.json in $absDir - pass -Dir <project root> or run from the repo."
        exit 1
    }
    if (-not (Get-Content $pkg -Raw | ConvertFrom-Json).scripts.tauri) {
        Write-Error "package.json in $absDir has no 'tauri' script - wrong directory?"
        exit 1
    }
    $existing = Get-PortOwnerPid -Port $Port
    if ($existing) {
        $p = Get-Process -Id $existing -ErrorAction SilentlyContinue
        Write-Error "Port $($Port) already in use by PID $existing ($($p.ProcessName)). Use 'restart' or 'stop' first."
        exit 1
    }
    Write-Host "Starting dev server in $absDir ..." -ForegroundColor Cyan
    # Detached cmd so your terminal stays usable; logs show in the new window.
    # '|| pause' keeps that window open when the command fails, so errors stop being invisible.
    $cmd = "cd /d `"$absDir`" && npm run tauri dev || pause"
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -WindowStyle Normal
    Write-Host "Dev server launching on port $Port (npm run tauri dev)." -ForegroundColor Green
}

switch ($Action) {
    'start'   { Start-DevServer -Dir $Dir -Port $Port }
    'stop'    { Stop-DevServer -Dir $Dir -Port $Port | Out-Null }
    'restart' {
        Write-Host '== restart: stopping first ==' -ForegroundColor Cyan
        Stop-DevServer -Dir $Dir -Port $Port | Out-Null
        Start-Sleep -Seconds 1
        Start-DevServer -Dir $Dir -Port $Port
    }
}
