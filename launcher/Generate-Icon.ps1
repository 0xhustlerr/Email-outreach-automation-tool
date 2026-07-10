# Builds launcher/app.ico (exe + tray icon)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outPath = Join-Path $PSScriptRoot 'app.ico'
$size = 256

$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

$bg = [System.Drawing.Color]::FromArgb(15, 23, 42)
$g.Clear($bg)

$rect = New-Object System.Drawing.Rectangle 12, 12, ($size - 24), ($size - 24)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(59, 130, 246),
    [System.Drawing.Color]::FromArgb(139, 92, 246),
    45
)
$g.FillEllipse($brush, $rect)

$font = New-Object System.Drawing.Font('Segoe UI', 108, [System.Drawing.FontStyle]::Bold)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$g.DrawString('@', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 10, $size, $size), $format)

$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$fs = [System.IO.File]::Create($outPath)
try {
    $icon.Save($fs)
}
finally {
    $fs.Close()
    $g.Dispose()
    $bmp.Dispose()
    $icon.Dispose()
}

Write-Host "Wrote $outPath"
