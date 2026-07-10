# Converts launcher/tray-icon.png -> launcher/app.ico (exe + tray + window)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = Join-Path $PSScriptRoot 'tray-icon.png'
$out = Join-Path $PSScriptRoot 'app.ico'

if (-not (Test-Path $src)) {
    throw "Missing tray icon source: $src"
}

$srcImg = [System.Drawing.Image]::FromFile($src)
# Keep envelope colors as-is (blue background); do not strip pixels.
$transparent = $srcImg
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$icons = New-Object System.Collections.Generic.List[System.Drawing.Icon]

try {
    foreach ($size in $sizes) {
        $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.DrawImage($transparent, 0, 0, $size, $size)
        $g.Dispose()
        $icons.Add([System.Drawing.Icon]::FromHandle($bmp.GetHicon()))
        $bmp.Dispose()
    }

    $fs = [System.IO.File]::Create($out)
    try {
        $icons[$icons.Count - 1].Save($fs)
    }
    finally {
        $fs.Close()
    }
}
finally {
    foreach ($icon in $icons) { $icon.Dispose() }
    if ($transparent -ne $srcImg) { $transparent.Dispose() }
    $srcImg.Dispose()
}

Write-Host "Wrote $out from $src"
