# Builds Email Finder.exe into the project root (tray launcher)
$ErrorActionPreference = 'Stop'
$launcherDir = $PSScriptRoot
$projectRoot = Split-Path $launcherDir -Parent
$userIco = Join-Path $projectRoot 'icon.ico'

if (-not (Test-Path $userIco)) {
    throw "Missing $userIco. Add your original icon.ico before building."
}

Set-Location $launcherDir
& "$launcherDir\Sync-AppIcon.ps1"
& "$launcherDir\Generate-NotificationBg.ps1"

Write-Host 'Cleaning previous Release build...'
dotnet clean -c Release -v q | Out-Null
if (Test-Path (Join-Path $launcherDir 'bin')) { Remove-Item (Join-Path $launcherDir 'bin') -Recurse -Force }
if (Test-Path (Join-Path $launcherDir 'obj')) { Remove-Item (Join-Path $launcherDir 'obj') -Recurse -Force }

$publishDir = Join-Path $launcherDir 'publish'
if (Test-Path $publishDir) { Remove-Item $publishDir -Recurse -Force }

Write-Host 'Publishing tray launcher (self-contained, ~70MB)...'
dotnet publish -c Release -r win-x64 --self-contained true -o $publishDir

$builtExe = Join-Path $publishDir 'Email Finder.exe'
$destExe = Join-Path $projectRoot 'Email Finder.exe'
if (-not (Test-Path $builtExe)) { throw "Build failed: $builtExe not found" }

function Stop-EmailFinderIfRunning {
    $procs = Get-Process -Name 'Email Finder' -ErrorAction SilentlyContinue
    if (-not $procs) { return $false }
    Write-Host 'Stopping running Email Finder (tray -> Quit first if you prefer)...'
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    return $true
}

function Copy-FileWithRetry {
    param([string]$Source, [string]$Destination, [int]$Retries = 5)
    for ($i = 0; $i -lt $Retries; $i++) {
        try {
            Copy-Item $Source $Destination -Force
            return $true
        }
        catch [System.IO.IOException] {
            if ($i -eq 0) { Stop-EmailFinderIfRunning | Out-Null }
            Start-Sleep -Milliseconds 800
        }
    }
    return $false
}

$deployedExe = $destExe
if (-not (Copy-FileWithRetry $builtExe $destExe)) {
    $altExe = Join-Path $projectRoot 'Email Finder.new.exe'
    Copy-Item $builtExe $altExe -Force
    $deployedExe = $altExe
    Write-Warning "Could not overwrite Email Finder.exe (file in use)."
    Write-Host "New build saved as: $altExe"
    Write-Host "Quit Email Finder from the system tray, then replace the old exe:"
    Write-Host "  del `"Email Finder.exe`""
    Write-Host "  ren `"Email Finder.new.exe`" `"Email Finder.exe`""
}

$exeMb = [math]::Round((Get-Item $deployedExe).Length / 1MB, 1)
if ($exeMb -lt 40) { Write-Warning "EXE is only ${exeMb} MB; expected about 60-80 MB." }

$loaderSrc = Join-Path $publishDir 'WebView2Loader.dll'
if (-not (Test-Path $loaderSrc)) {
    $loaderSrc = Join-Path $publishDir 'runtimes\win-x64\native\WebView2Loader.dll'
}
if (-not (Test-Path $loaderSrc)) {
    $loaderSrc = Join-Path $env:USERPROFILE '.nuget\packages\microsoft.web.webview2\1.0.2792.45\runtimes\win-x64\native\WebView2Loader.dll'
}
if (-not (Test-Path $loaderSrc)) { throw 'WebView2Loader.dll not found. Restore NuGet packages and rebuild.' }

foreach ($destDir in @($projectRoot, $publishDir)) {
    $icoDest = Join-Path $destDir 'icon.ico'
    if (-not (Test-Path $icoDest) -or ((Get-Item $userIco).FullName -ne (Resolve-Path $icoDest).Path)) {
        Copy-Item $userIco $icoDest -Force
    }
    Copy-Item $loaderSrc (Join-Path $destDir 'WebView2Loader.dll') -Force
}

$stale = Join-Path $projectRoot 'taskbar.ico'
if (Test-Path $stale) { Remove-Item $stale -Force }

Copy-Item (Join-Path $launcherDir 'notification-bg.png') (Join-Path $projectRoot 'notification-bg.png') -Force
Copy-Item (Join-Path $launcherDir 'notification-bg.png') (Join-Path $publishDir 'notification-bg.png') -Force

Write-Host ''
Write-Host "Done: $deployedExe"
Write-Host 'Beside exe: icon.ico (your original), WebView2Loader.dll'
