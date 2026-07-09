# Install additional English voices for Windows
# Run this in an elevated PowerShell (Run as Administrator)

Write-Host "Installing additional English voices..." -ForegroundColor Cyan

# List of available OneCore voice packages
$voices = @(
    "en-US",
    "en-GB",
    "en-AU",
    "en-CA",
    "en-IN"
)

foreach ($lang in $voices) {
    Write-Host "`nTrying to install $lang voices..." -ForegroundColor Yellow
    try {
        # Use the OneCore voices which are built-in
        $package = Get-AppxPackage -Name "*OneCore*" -AllUsers -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*$lang*" }
        if ($package) {
            Write-Host "  Found: $($package.Name)" -ForegroundColor Green
        } else {
            Write-Host "  No OneCore package found for $lang" -ForegroundColor Gray
        }
    } catch {
        Write-Host "  Error: $_" -ForegroundColor Red
    }
}

# Try to install via Windows capabilities
Write-Host "`nChecking Windows capabilities for speech..." -ForegroundColor Cyan
$capabilities = Get-WindowsCapability -Online | Where-Object { $_.Name -like "*Speech*" -and $_.State -ne "Installed" }
foreach ($cap in $capabilities) {
    Write-Host "  Installing: $($cap.Name)..." -ForegroundColor Yellow
    try {
        Add-WindowsCapability -Online -Name $cap.Name -ErrorAction Stop
        Write-Host "  Installed successfully!" -ForegroundColor Green
    } catch {
        Write-Host "  Failed: $_" -ForegroundColor Red
    }
}

Write-Host "`nDone! Restart the app to see new voices." -ForegroundColor Cyan
