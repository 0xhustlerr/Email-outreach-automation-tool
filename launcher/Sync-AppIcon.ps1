# Uses ONLY the user's icon.ico and optional app-icon.png. Does not build or convert ICO files.
$ErrorActionPreference = 'Stop'

$launcherDir = $PSScriptRoot
$projectRoot = Split-Path $launcherDir -Parent
$userIco = Join-Path $projectRoot 'icon.ico'

if (-not (Test-Path $userIco)) {
    throw "Place your original icon.ico at $userIco before building."
}

Copy-Item $userIco (Join-Path $projectRoot 'public\favicon.ico') -Force
$appDir = Join-Path $projectRoot 'app'
if (-not (Test-Path $appDir)) { New-Item -ItemType Directory -Force -Path $appDir | Out-Null }
Copy-Item $userIco (Join-Path $projectRoot 'app\favicon.ico') -Force

$pngSrc = Join-Path $projectRoot 'app-icon.png'
if (-not (Test-Path $pngSrc)) {
    $pngSrc = Join-Path $projectRoot 'tray-icon.png'
}

if (Test-Path $pngSrc) {
    $publicDir = Join-Path $projectRoot 'public'
    if (-not (Test-Path $publicDir)) { New-Item -ItemType Directory -Force -Path $publicDir | Out-Null }
    Copy-Item $pngSrc (Join-Path $publicDir 'app-icon.png') -Force
    Copy-Item $pngSrc (Join-Path $projectRoot 'app\icon.png') -Force
    Write-Host "Web PNG from $(Split-Path $pngSrc -Leaf) (unchanged)"
}

Write-Host "Using original icon.ico ($((Get-Item $userIco).Length) bytes), no ICO conversion."
