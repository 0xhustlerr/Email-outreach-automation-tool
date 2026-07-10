<#
  Builds a PORTABLE bundle of Cold Outreach Command Center that runs on another
  Windows PC with nothing installed: no Node.js, no npm, no project checkout.

  Output:
    dist\Cold Outreach Command Center\        <- the runnable folder
    dist\Cold Outreach Command Center.zip      <- zip to copy to the other PC

  The target user unzips it and double-clicks
  "Cold Outreach Command Center.exe". The launcher starts the bundled Node
  running the production server, then opens the app in its window.

  Usage:
    powershell -ExecutionPolicy Bypass -File build-portable.ps1
    powershell -ExecutionPolicy Bypass -File build-portable.ps1 -SkipBuild   # reuse existing .next build
#>
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$launcherProj = Join-Path $projectRoot 'launcher\EmailFinderTray.csproj'
$standalone = Join-Path $projectRoot '.next\standalone'
$staticDir = Join-Path $projectRoot '.next\static'
$publicDir = Join-Path $projectRoot 'public'
$nodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$distDir = Join-Path $projectRoot 'dist'
$bundleName = 'Cold Outreach Command Center'
$bundleDir = Join-Path $distDir $bundleName
$zipPath = Join-Path $distDir 'Cold-Outreach-Command-Center.zip'
$publishTmp = Join-Path $projectRoot 'launcher\publish-portable'

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# --- 0. Prerequisites --------------------------------------------------------
if (-not (Test-Path $nodeExe)) { throw "Bundled Node source not found at $nodeExe. Install Node.js (x64) first." }
$nodeVer = (& $nodeExe --version)
Step "Bundling Node runtime $nodeVer (must match the ABI better-sqlite3 was built with)"

# --- 1. Production build (Next standalone) ----------------------------------
# Turbopack (the `next build` default) crashes on this project, so force webpack.
if ($SkipBuild) {
    Step 'Skipping build (-SkipBuild); reusing existing .next\standalone'
} else {
    Step 'Building production server (next build --webpack, output: standalone)...'
    Push-Location $projectRoot
    try { & npx next build --webpack } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "next build failed (exit $LASTEXITCODE)." }
}
if (-not (Test-Path (Join-Path $standalone 'server.js'))) {
    throw "Standalone server not found. Is `output: 'standalone'` set in next.config.mjs?"
}

# --- 2. Publish the launcher (self-contained single exe) --------------------
Step 'Publishing launcher (self-contained, single file)...'
if (Test-Path $publishTmp) { Remove-Item $publishTmp -Recurse -Force }
& dotnet publish $launcherProj -c Release -r win-x64 --self-contained true -o $publishTmp | Out-Null
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed (exit $LASTEXITCODE)." }
$builtExe = Join-Path $publishTmp 'Email Finder.exe'
if (-not (Test-Path $builtExe)) { throw "Launcher exe not found at $builtExe" }
$loaderDll = Join-Path $publishTmp 'WebView2Loader.dll'
if (-not (Test-Path $loaderDll)) { $loaderDll = Join-Path $projectRoot 'WebView2Loader.dll' }
if (-not (Test-Path $loaderDll)) { throw 'WebView2Loader.dll not found (publish output or project root).' }

# --- 3. Assemble the bundle folder ------------------------------------------
Step "Assembling bundle at: $bundleDir"
if (Test-Path $bundleDir) { Remove-Item $bundleDir -Recurse -Force }
New-Item -ItemType Directory -Path $bundleDir -Force | Out-Null

# 3a. Standalone server + traced node_modules (server.js, package.json, .next/…)
Copy-Item (Join-Path $standalone '*') $bundleDir -Recurse -Force
# Start every recipient with a clean database.
$bundledData = Join-Path $bundleDir '.data'
if (Test-Path $bundledData) { Remove-Item $bundledData -Recurse -Force }

# 3b. Static assets + public/ (standalone does NOT include these).
New-Item -ItemType Directory -Path (Join-Path $bundleDir '.next') -Force | Out-Null
Copy-Item $staticDir (Join-Path $bundleDir '.next\static') -Recurse -Force
if (Test-Path $publicDir) { Copy-Item $publicDir (Join-Path $bundleDir 'public') -Recurse -Force }

# 3c. Bundled Node runtime.
New-Item -ItemType Directory -Path (Join-Path $bundleDir 'node') -Force | Out-Null
Copy-Item $nodeExe (Join-Path $bundleDir 'node\node.exe') -Force

# 3d. start.js — loads .env.local exactly like Next dev/build, then the server.
$startJs = @'
// Portable bundle entry. Loads .env.local / .env exactly like `next dev` and
// `next build` (via @next/env), so multi-line and quoted values such as
// MAIL_IDENTITIES parse identically, then boots the standalone server. PORT,
// HOSTNAME and NODE_ENV are supplied by the launcher and are left untouched.
try {
  const { loadEnvConfig } = require("@next/env");
  loadEnvConfig(process.cwd(), false);
} catch (err) {
  console.error("[start] could not load .env files:", err && err.message);
}
require("./server.js");
'@
Set-Content -Path (Join-Path $bundleDir 'start.js') -Value $startJs -Encoding UTF8

# 3e. Launcher exe (renamed to the product name) + its runtime files.
Copy-Item $builtExe (Join-Path $bundleDir "$bundleName.exe") -Force
Copy-Item $loaderDll (Join-Path $bundleDir 'WebView2Loader.dll') -Force
$icon = Join-Path $projectRoot 'icon.ico'
if (Test-Path $icon) { Copy-Item $icon (Join-Path $bundleDir 'icon.ico') -Force }
$notif = Join-Path $projectRoot 'notification-bg.png'
if (-not (Test-Path $notif)) { $notif = Join-Path $projectRoot 'launcher\notification-bg.png' }
if (Test-Path $notif) { Copy-Item $notif (Join-Path $bundleDir 'notification-bg.png') -Force }

# 3f. Ship CLEAN: no .env.local, no secrets, no Google Sheet. Each user starts
#     empty and adds their own Gmail account(s) in the in-app Accounts page,
#     which stores them in the local database beside the exe.
$quickStart = @'
Cold Outreach Command Center
============================

1. Double-click "Cold Outreach Command Center.exe".
2. When the window opens, click "Accounts" (top bar).
3. Add your Gmail account:
     - Display name + your Gmail address
     - a Gmail App Password (the app shows a step-by-step guide)
4. (Optional) In "Reply sync setup", connect reading of incoming replies
   by following the built-in from-zero guide.

Everything you enter is saved on THIS computer only (a local database next
to the exe). No Google Sheet, no shared accounts. Unzip somewhere writable
(Desktop/Documents), not Program Files. Needs Windows 10/11.
'@
Set-Content -Path (Join-Path $bundleDir 'READ ME FIRST.txt') -Value $quickStart -Encoding UTF8

# --- 4. Zip it --------------------------------------------------------------
Step 'Compressing to zip...'
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($bundleDir, $zipPath)

# --- 5. Summary -------------------------------------------------------------
$sizeMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host ''
Write-Host "Done." -ForegroundColor Green
Write-Host "  Folder: $bundleDir"
Write-Host "  Zip:    $zipPath  (${sizeMb} MB)"
Write-Host ''
Write-Host 'On the other PC: unzip anywhere writable (Desktop/Documents, NOT Program Files),'
Write-Host 'then double-click "Cold Outreach Command Center.exe". Needs Windows 10/11 with the'
Write-Host 'Edge WebView2 runtime (preinstalled on Win11 and most updated Win10).'
Write-Host ''
Write-Host 'This bundle is CLEAN: no .env.local, no secrets, no Google Sheet. Each user opens' -ForegroundColor Green
Write-Host 'the app and adds their own Gmail account in the Accounts page (stored locally).' -ForegroundColor Green
