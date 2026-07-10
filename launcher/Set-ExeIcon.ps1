# Forces the Win32 icon resource on a built .exe (fixes Explorer when ApplicationIcon embed fails).
param(
    [Parameter(Mandatory = $true)]
    [string]$ExePath,
    [Parameter(Mandatory = $true)]
    [string]$IconPath
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ExePath)) { throw "EXE not found: $ExePath" }
if (-not (Test-Path $IconPath)) { throw "ICO not found: $IconPath" }

$rcedit = Join-Path $PSScriptRoot 'tools\rcedit-x64.exe'
if (-not (Test-Path $rcedit)) {
    $tools = Join-Path $PSScriptRoot 'tools'
    New-Item -ItemType Directory -Force -Path $tools | Out-Null
    Invoke-WebRequest `
        -Uri 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe' `
        -OutFile $rcedit `
        -UseBasicParsing
}

& $rcedit $ExePath --set-icon $IconPath
if ($LASTEXITCODE -ne 0) {
    throw "rcedit failed with exit code $LASTEXITCODE"
}

(Get-Item $ExePath).LastWriteTime = Get-Date
Write-Host "Set icon on $ExePath from $IconPath"
