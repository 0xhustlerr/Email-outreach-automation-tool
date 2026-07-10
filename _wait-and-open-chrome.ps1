param(
    [int]$Port = 3005,
    [string]$PortFile = ''
)

$ErrorActionPreference = 'Stop'

if ($PortFile -and (Test-Path $PortFile)) {
    $Port = [int]((Get-Content -Path $PortFile -Raw).Trim())
}

if ($Port -le 0) {
    Write-Error 'Port is not set.'
    exit 1
}

$port = $Port

$url = "http://127.0.0.1:$port"
$marker = 'Cold Outreach Command Center'

for ($i = 0; $i -lt 120; $i++) {
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
        if ($response.Content -like "*$marker*") {
            $chromePaths = @(
                "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
                "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
                "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
            )
            $chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
            if ($chrome) {
                Start-Process -FilePath $chrome -ArgumentList $url
            } else {
                Start-Process $url
            }
            exit 0
        }
    } catch {
        # Server not ready yet, or wrong app on this port
    }
    Start-Sleep -Seconds 1
}

Write-Error "Timed out waiting for this project at $url (expected page title containing '$marker')."
exit 1
