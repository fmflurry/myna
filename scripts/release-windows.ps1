# Builds, signs, and verifies the Windows release bundle for Myna.
#
# Mirror of scripts/release-macos.sh for windows-latest CI (and local
# PowerShell runs). Differences from the macOS flow are all platform-shaped:
# Authenticode (signtool) replaces codesign, and there is no notarization
# step at all — notarization is an Apple-only concept.
#
# Signing behavior:
#   - WINDOWS_CERT_PATH + WINDOWS_CERT_PASSWORD set: the produced
#     *-setup.exe / *.msi installers are signed with signtool (SHA256 +
#     RFC 3161 timestamp) after `tauri build`, then verified with
#     `signtool verify /pa`.
#   - Otherwise: the build ships unsigned with a loud warning, exactly like
#     the macOS ad-hoc fallback. Windows SmartScreen will flag unsigned
#     installers until a certificate is configured.
#
# TAURI_SIGNING_PRIVATE_KEY (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD when the
# key has one) is required: bundle.createUpdaterArtifacts is true in
# tauri.conf.json, so without it the updater artifact ships unsigned.
$ErrorActionPreference = 'Stop'

# --- Environment -------------------------------------------------------
# GitHub Actions `env:` creates the variable even when the backing secret is
# unset, so an unconfigured secret arrives as "" rather than missing. Treat
# set-but-empty as unset so presence checks below behave like a local run.
foreach ($name in @('TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
                    'WINDOWS_CERT_PATH', 'WINDOWS_CERT_PASSWORD', 'WINDOWS_CERT_THUMBPRINT')) {
  if ((Test-Path "env:$name") -and [string]::IsNullOrEmpty((Get-Item "env:$name").Value)) {
    Remove-Item "env:$name"
  }
}

$RepoRoot  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$BundleDir = Join-Path $RepoRoot 'target\release\bundle'
$NsisDir   = Join-Path $BundleDir 'nsis'
$MsiDir    = Join-Path $BundleDir 'msi'

function Log($msg)  { Write-Host "`n==> $msg" }
function Warn($msg) { Write-Warning $msg }
function Fail($msg) { Write-Error "`nFAIL: $msg"; exit 1 }

function Find-Signtool {
  $cmd = Get-Command signtool -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $kits = 'C:\Program Files (x86)\Windows Kits\10\bin'
  if (Test-Path $kits) {
    $found = Get-ChildItem $kits -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1
    if ($found) { return $found.FullName }
  }
  return $null
}

# --- 1. Clean stale artifacts -------------------------------------------
# Never trust a leftover target/release tree: a prior build once "succeeded"
# purely off a cached binary while the link step never ran.
Log 'Removing stale build artifacts'
Remove-Item (Join-Path $RepoRoot 'target\release\myna.exe') -Force -ErrorAction SilentlyContinue
Remove-Item $BundleDir -Recurse -Force -ErrorAction SilentlyContinue

$modelsDir = Join-Path $env:USERPROFILE 'myna\models'
if (-not (Test-Path $modelsDir)) {
  Warn "$modelsDir does not exist — the packaged app will report every model missing at runtime."
}

# --- 2. Verify updater signing key is configured ------------------------
$tauriConf = Get-Content (Join-Path $RepoRoot 'app\src-tauri\tauri.conf.json') -Raw
if ($tauriConf -match '"createUpdaterArtifacts"\s*:\s*true') {
  if (-not (Test-Path 'env:TAURI_SIGNING_PRIVATE_KEY')) {
    Fail 'createUpdaterArtifacts is true in tauri.conf.json but TAURI_SIGNING_PRIVATE_KEY is not set — the updater artifact would ship unsigned. See docs/releasing-macos.md.'
  }
  Log 'Updater signing key present (TAURI_SIGNING_PRIVATE_KEY is set).'
}

# --- 3. Build ------------------------------------------------------------
Log 'Building (tauri build --bundles nsis,msi)'
Push-Location $RepoRoot
try {
  npx tauri build --bundles nsis,msi --ci
  if ($LASTEXITCODE -ne 0) { Fail "tauri build exited with code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$installers = @()
foreach ($dir in @($NsisDir, $MsiDir)) {
  if (-not (Test-Path $dir)) { continue }
  foreach ($pattern in @('*.exe', '*.msi')) {
    $installers += Get-ChildItem $dir -Filter $pattern -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notmatch 'uninstall' }
  }
}
if ($installers.Count -eq 0) { Fail "No installers produced under $BundleDir (expected *-setup.exe and/or *.msi)" }
foreach ($file in $installers) {
  if ($file.Length -eq 0) { Fail "$($file.FullName) exists but is empty" }
  Log "Produced: $($file.FullName) ($([math]::Round($file.Length / 1MB, 1)) MB)"
}

# --- 4. Authenticode sign + verify ---------------------------------------
$signtool = Find-Signtool
if (-not $signtool) { Fail 'signtool.exe not found — install the Windows SDK or run on a windows-latest GitHub runner' }

$signed = $false
if ((Test-Path 'env:WINDOWS_CERT_PATH') -and (Test-Path 'env:WINDOWS_CERT_PASSWORD')) {
  Log "Signing installers with Authenticode certificate at $env:WINDOWS_CERT_PATH"
  foreach ($file in $installers) {
    & $signtool sign /fd SHA256 /f $env:WINDOWS_CERT_PATH /p $env:WINDOWS_CERT_PASSWORD `
      /tr http://timestamp.digicert.com /td SHA256 $file.FullName
    if ($LASTEXITCODE -ne 0) { Fail "signtool sign failed on $($file.FullName)" }
  }
  $signed = $true
} elseif (Test-Path 'env:WINDOWS_CERT_THUMBPRINT') {
  Log "Signing installers with store certificate $env:WINDOWS_CERT_THUMBPRINT"
  foreach ($file in $installers) {
    & $signtool sign /fd SHA256 /sha1 $env:WINDOWS_CERT_THUMBPRINT `
      /tr http://timestamp.digicert.com /td SHA256 $file.FullName
    if ($LASTEXITCODE -ne 0) { Fail "signtool sign failed on $($file.FullName)" }
  }
  $signed = $true
} else {
  Warn 'No Authenticode certificate configured (WINDOWS_CERT_PATH + WINDOWS_CERT_PASSWORD, or WINDOWS_CERT_THUMBPRINT). Shipping UNSIGNED — SmartScreen will warn on install.'
}

if ($signed) {
  Log 'Verifying Authenticode signatures (signtool verify /pa)'
  foreach ($file in $installers) {
    & $signtool verify /pa $file.FullName
    if ($LASTEXITCODE -ne 0) { Fail "signtool verify /pa failed on $($file.FullName)" }
  }
  Log 'signtool verify /pa: OK'
}

# --- 5. Verify the updater artifacts --------------------------------------
$sigs = @()
foreach ($dir in @($NsisDir, $MsiDir)) {
  if (Test-Path $dir) { $sigs += Get-ChildItem $dir -Filter '*.sig' -File -ErrorAction SilentlyContinue }
}
if ($sigs.Count -eq 0) { Fail 'No .sig updater signatures found under target/release/bundle — was createUpdaterArtifacts true and did tauri build succeed?' }
foreach ($sig in $sigs) {
  if ($sig.Length -eq 0) { Fail "$($sig.FullName) exists but is empty" }
}
Log "Updater signatures present: $($sigs.Count)"

# --- 6. Summary ------------------------------------------------------------
Log 'Release summary'
Write-Host "  Signed (Authenticode): $(if ($signed) { 'yes' } else { 'no (unsigned — SmartScreen will warn)' })"
foreach ($file in $installers) { Write-Host "  Installer: $($file.FullName)" }
foreach ($sig in $sigs)         { Write-Host "  Signature: $($sig.FullName)" }

Log 'Done.'
