# Builds launcher/icon.ico for PE embed: high-res frames first, skip tiny legacy frames.
param(
    [string]$SourceIco,
    [string]$OutIco
)

$ErrorActionPreference = 'Stop'
$multi = Join-Path $PSScriptRoot 'Build-MultiClassicAppIco.ps1'
$tempDir = Join-Path $PSScriptRoot 'icons'
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

Add-Type -AssemblyName System.Drawing
foreach ($size in @(48, 64, 128, 256, 32)) {
    try {
        $icon = New-Object System.Drawing.Icon $SourceIco, $size, $size
        $bmp = $icon.ToBitmap()
        $bmp.Save((Join-Path $tempDir "mail-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        $icon.Dispose()
        $bmp.Dispose()
        Write-Host "  extracted ${size}px"
    }
    catch {
        Write-Host "  skip ${size}px"
    }
}

& $multi -IconsDir $tempDir -OutPath $OutIco -Sizes @(48, 64, 128, 256, 32)
$test = New-Object System.Drawing.Icon $OutIco
Write-Host "Launcher embed icon: $OutIco ($($test.Width)x$($test.Height) default, $((Get-Item $OutIco).Length) bytes)"
$test.Dispose()
