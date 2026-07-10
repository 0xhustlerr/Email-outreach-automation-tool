# Builds a .NET-compatible app.ico from one native PNG (Icon.Save = classic BMP format).
param(
    [string]$PngPath,
    [string]$OutPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not ('User32' -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class User32 {
  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern bool DestroyIcon(IntPtr hIcon);
}
"@
}

if (-not (Test-Path $PngPath)) {
    throw "PNG not found: $PngPath"
}

$bmp = [System.Drawing.Bitmap]::FromFile($PngPath)
try {
    $hIcon = $bmp.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($hIcon)
    $fs = [System.IO.File]::Create($OutPath)
    try {
        $icon.Save($fs)
    }
    finally {
        $fs.Close()
        $icon.Dispose()
        [void][User32]::DestroyIcon($hIcon)
    }
}
finally {
    $bmp.Dispose()
}

$test = New-Object System.Drawing.Icon $OutPath
$test.Dispose()
Write-Host "Wrote classic ICO: $OutPath ($((Get-Item $OutPath).Length) bytes) from $(Split-Path $PngPath -Leaf)"
