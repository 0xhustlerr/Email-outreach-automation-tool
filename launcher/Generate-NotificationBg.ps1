# Builds launcher/notification-bg.png (custom toast background)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outPath = Join-Path $PSScriptRoot 'notification-bg.png'
$w = 420
$h = 140

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

$g.Clear([System.Drawing.Color]::FromArgb(15, 23, 42))

$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Rectangle 0, 0, $w, $h),
    [System.Drawing.Color]::FromArgb(30, 58, 138),
    [System.Drawing.Color]::FromArgb(88, 28, 135),
    35
)
$g.FillRectangle($brush, 0, 0, $w, $h)

$glow = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Rectangle 0, 0, $w, $h),
    [System.Drawing.Color]::FromArgb(80, 59, 130, 246),
    [System.Drawing.Color]::FromArgb(0, 139, 92, 246),
    90
)
$g.FillRectangle($glow, 0, 0, $w, $h)

$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(90, 255, 255, 255), 1.5)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 14
$path.AddArc(0, 0, $radius * 2, $radius * 2, 180, 90)
$path.AddArc($w - $radius * 2, 0, $radius * 2, $radius * 2, 270, 90)
$path.AddArc($w - $radius * 2, $h - $radius * 2, $radius * 2, $radius * 2, 0, 90)
$path.AddArc(0, $h - $radius * 2, $radius * 2, $radius * 2, 90, 90)
$path.CloseFigure()
$g.DrawPath($pen, $path)

$font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Regular)
$g.DrawString('Cold Outreach Command Center', $font, [System.Drawing.Brushes]::White, 16, 12)

$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
$brush.Dispose()
$glow.Dispose()
$pen.Dispose()
$path.Dispose()

Write-Host "Wrote $outPath"
