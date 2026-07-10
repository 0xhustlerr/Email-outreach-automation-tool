# Multi-resolution .ico from native PNGs using classic BMP entries (.NET + Explorer compatible).
param(
    [string]$IconsDir = (Join-Path $PSScriptRoot 'icons'),
    [string]$OutPath = (Join-Path $PSScriptRoot 'app.ico'),
    [int[]]$Sizes = @(16, 24, 32, 48, 64, 128, 256)
)

function Merge-ClassicIcoFiles {
    param(
        [string[]]$SingleIcoPaths,
        [string]$OutPath
    )

    $entries = New-Object System.Collections.Generic.List[byte[]]
    $dataBlocks = New-Object System.Collections.Generic.List[byte[]]

    foreach ($path in $SingleIcoPaths) {
        $bytes = [System.IO.File]::ReadAllBytes($path)
        if ($bytes.Length -lt 22) {
            throw "Invalid ICO: $path"
        }

        $count = [BitConverter]::ToUInt16($bytes, 4)
        if ($count -lt 1) {
            throw "No images in $path"
        }

        for ($i = 0; $i -lt $count; $i++) {
            $entryStart = 6 + ($i * 16)
            $entry = $bytes[$entryStart..($entryStart + 15)]
            $dataOffset = [BitConverter]::ToUInt32($entry, 12)
            if ($dataOffset -ge $bytes.Length) {
                throw "Corrupt ICO entry in $path"
            }

            $dataLen = $bytes.Length - $dataOffset
            $imageData = New-Object byte[] $dataLen
            [Array]::Copy($bytes, $dataOffset, $imageData, 0, $dataLen)
            $entries.Add($entry)
            $dataBlocks.Add($imageData)
        }
    }

    $imageCount = $entries.Count
    $headerSize = 6 + (16 * $imageCount)
    $offset = $headerSize
    $outMs = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter $outMs

    $bw.Write([uint16]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]$imageCount)

    for ($i = 0; $i -lt $imageCount; $i++) {
        $entry = $entries[$i]
        $data = $dataBlocks[$i]
        [BitConverter]::GetBytes([uint32]$data.Length).CopyTo($entry, 8)
        [BitConverter]::GetBytes([uint32]$offset).CopyTo($entry, 12)
        $bw.Write($entry)
        $offset += $data.Length
    }

    foreach ($data in $dataBlocks) {
        $bw.Write($data)
    }

    $bw.Close()
    [System.IO.File]::WriteAllBytes($OutPath, $outMs.ToArray())
    $outMs.Close()
}

$ErrorActionPreference = 'Stop'
$buildOne = Join-Path $PSScriptRoot 'Build-ClassicAppIco.ps1'
if (-not (Test-Path $buildOne)) {
    throw "Missing Build-ClassicAppIco.ps1"
}

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("email-finder-ico-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

$singleIcos = New-Object System.Collections.Generic.List[string]
try {
    foreach ($size in $Sizes) {
        $png = Join-Path $IconsDir "mail-$size.png"
        if (-not (Test-Path $png)) {
            Write-Host "Skip $size (no mail-$size.png)"
            continue
        }

        $oneIco = Join-Path $tempDir "mail-$size.ico"
        & $buildOne -PngPath $png -OutPath $oneIco | Out-Null
        $singleIcos.Add($oneIco)
    }

    if ($singleIcos.Count -eq 0) {
        throw "No PNGs found for sizes in $IconsDir"
    }

    Merge-ClassicIcoFiles -SingleIcoPaths $singleIcos.ToArray() -OutPath $OutPath
    Add-Type -AssemblyName System.Drawing
    $test = New-Object System.Drawing.Icon $OutPath
    Write-Host "Merged $($singleIcos.Count) sizes -> $OutPath ($($test.Width)x$($test.Height) default, $((Get-Item $OutPath).Length) bytes)"
    $test.Dispose()
}
finally {
    if (Test-Path $tempDir) {
        Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
