#!/usr/bin/env pwsh
# Dev-only helper: detects a broken sharp installation on Windows and removes it.
# Running this script is NOT required for production; the Docker image intentionally
# does not depend on sharp at runtime.

$err = $null
try {
    node -e "require('sharp'); console.log('sharp OK')" 2>$null
} catch {
    $err = $_
}

if ($err) {
    Write-Host "sharp missing native binary — removing from deps"
    npm uninstall sharp --silent 2>$null
}
