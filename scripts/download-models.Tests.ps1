# Behavioral tests for scripts/download-models.ps1.
# Runs under pwsh on Linux/macOS: Join-Path rejects "\\?\" the same way
# Windows PowerShell 5.1 does, and a fake curl.exe stands in for downloads.
$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSVersion.Major -lt 7) {
  Write-Output "FAIL this file requires pwsh 7 (Join-Path and curl.exe probes)"
  exit 1
}

$ScriptPath = Join-Path $PSScriptRoot "download-models.ps1"
$Shard1Name = "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf"
$Shard2Name = "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf"
$Shard1Min = [int64]3993201344
$Shard2Min = [int64]689872288
$QwenDir = "qwen2.5-7b-instruct"
$failures = 0

function Pass([string]$Name) { Write-Output "PASS $Name" }
function Fail([string]$Name, [string]$Detail) {
  Write-Output "FAIL $Name"
  if ($Detail) { Write-Output $Detail }
  $script:failures++
}

function New-Sandbox {
  $root = Join-Path ([System.IO.Path]::GetTempPath()) ("myna-ps1-" + [guid]::NewGuid().ToString("n"))
  New-Item -ItemType Directory -Force -Path (Join-Path $root "scripts") | Out-Null
  Copy-Item -LiteralPath $ScriptPath -Destination (Join-Path $root "scripts/download-models.ps1")
  return $root
}

function Set-Bytes([string]$Path, [int64]$Length) {
  $parent = Split-Path -Parent $Path
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $stream = [System.IO.File]::Open(
    $Path,
    [System.IO.FileMode]::Create,
    [System.IO.FileAccess]::Write)
  try { $stream.SetLength($Length) } finally { $stream.Dispose() }
}

function New-FakeCurl([string]$Dir, [int]$ExitCode) {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $log = Join-Path $Dir "args.log"
  $exe = Join-Path $Dir "curl.exe"
  $template = @'
#!/bin/sh
printf '%s\n' "$*" >> "__LOG__"
exit __CODE__
'@
  $text = $template.Replace("__LOG__", $log).Replace("__CODE__", "$ExitCode")
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($exe, $text, $utf8)
  & /bin/chmod +x $exe | Out-Null
  return $log
}

function Invoke-DownloadScript {
  param(
    [string]$Root,
    [string[]]$ArgumentList,
    [string]$FakeCurlDir
  )
  $script = Join-Path $Root "scripts/download-models.ps1"
  $previousPath = $env:PATH
  if ($FakeCurlDir) {
    $env:PATH = $FakeCurlDir + [IO.Path]::PathSeparator + $env:PATH
  }
  $output = & timeout 20s pwsh -NoProfile -File $script @ArgumentList 2>&1 | Out-String
  $code = $LASTEXITCODE
  $env:PATH = $previousPath
  return @{ Output = $output; Code = $code }
}

function Assert-CheckListsBothShards {
  param([string]$Name, [string]$Output, [string]$RealDest, [int]$Code)
  if ($Output -match 'drive' -and $Output -match 'null') {
    Fail $Name $Output
    return
  }
  if ($Output -notlike "*$RealDest*") {
    Fail "$Name should keep the destination path usable" $Output
    return
  }
  if ($Output -notlike "*$Shard1Name*" -or $Output -notlike "*$Shard2Name*") {
    Fail "$Name should list both Qwen shards" $Output
    return
  }
  if ($Code -eq 0 -or $Code -eq 124) {
    Fail "$Name should exit non-zero when shards are missing (code $Code)" $Output
    return
  }
  Pass $Name
}

function Assert-Fetches {
  param([string]$Name, $Result, [string]$CurlLog)
  if ($Result.Code -eq 124) {
    Fail "$Name timed out (download was not intercepted)" $Result.Output
    return
  }
  if ($Result.Output -notlike "*Fetching*Qwen*") {
    Fail "$Name should fetch" $Result.Output
    return
  }
  if ($Result.Output -like "*SKIP (already present*") {
    Fail "$Name should not skip" $Result.Output
    return
  }
  if (-not (Test-Path -LiteralPath $CurlLog)) {
    Fail "$Name should call curl.exe" $Result.Output
    return
  }
  $logged = Get-Content -LiteralPath $CurlLog -Raw
  if ($logged -notlike "*-fSL*" -or $logged -notlike "*-C -*" -or $logged -notlike "*--retry 3*" -or $logged -notlike "*--retry-delay 2*") {
    Fail "$Name should pass curl resume and retry flags" $logged
    return
  }
  Pass $Name
}

Remove-Item Env:MYNA_MODELS_DIR -ErrorAction SilentlyContinue

# -Dest and MYNA_MODELS_DIR with a "\\?\" prefix must not crash Join-Path.
$root = New-Sandbox
$real = Join-Path $root "dest"
New-Item -ItemType Directory -Force -Path $real | Out-Null
$verbatim = "\\?\" + $real
$checked = Invoke-DownloadScript -Root $root -ArgumentList @("-Check", "-Dest", $verbatim)
Assert-CheckListsBothShards -Name "-Check accepts a verbatim -Dest" -Output $checked.Output -RealDest $real -Code $checked.Code

$env:MYNA_MODELS_DIR = $verbatim
$fromEnv = Invoke-DownloadScript -Root $root -ArgumentList @("-Check")
Remove-Item Env:MYNA_MODELS_DIR -ErrorAction SilentlyContinue
Assert-CheckListsBothShards -Name "-Check accepts a verbatim MYNA_MODELS_DIR" -Output $fromEnv.Output -RealDest $real -Code $fromEnv.Code

$plain = Invoke-DownloadScript -Root $root -ArgumentList @("-Check", "-Dest", $real)
Assert-CheckListsBothShards -Name "-Check lists both Qwen shards" -Output $plain.Output -RealDest $real -Code $plain.Code

function Assert-QwenFetch {
  param([string]$Name, [scriptblock]$Arrange)
  $case = New-Sandbox
  $dest = Join-Path $case "dest"
  & $Arrange $case $dest
  $fake = Join-Path $case "fake-curl"
  $log = New-FakeCurl -Dir $fake -ExitCode 0
  $result = Invoke-DownloadScript -Root $case -ArgumentList @("-Dest", $dest, "-Only", "qwen") -FakeCurlDir $fake
  Assert-Fetches -Name $Name -Result $result -CurlLog $log
  Remove-Item -LiteralPath $case -Recurse -Force -ErrorAction SilentlyContinue
}

Assert-QwenFetch "part 1 alone is not skipped" {
  param($case, $dest)
  Set-Bytes (Join-Path $dest "$QwenDir/$Shard1Name") $Shard1Min
}

Assert-QwenFetch "undersized part 1 is not skipped" {
  param($case, $dest)
  Set-Bytes (Join-Path $dest "$QwenDir/$Shard1Name") ($Shard1Min - 1)
  Set-Bytes (Join-Path $dest "$QwenDir/$Shard2Name") $Shard2Min
}

Assert-QwenFetch "undersized part 2 is not skipped" {
  param($case, $dest)
  Set-Bytes (Join-Path $dest "$QwenDir/$Shard1Name") $Shard1Min
  Set-Bytes (Join-Path $dest "$QwenDir/$Shard2Name") ($Shard2Min - 1)
}

Assert-QwenFetch "partial destination is not abandoned for a legacy copy" {
  param($case, $dest)
  Set-Bytes (Join-Path $dest "$QwenDir/$Shard1Name") $Shard1Min
  Set-Bytes (Join-Path $case "models/$QwenDir/$Shard1Name") $Shard1Min
  Set-Bytes (Join-Path $case "models/$QwenDir/$Shard2Name") $Shard2Min
}

Assert-QwenFetch "incomplete legacy copy is not skipped" {
  param($case, $dest)
  Set-Bytes (Join-Path $case "models/$QwenDir/$Shard1Name") $Shard1Min
}

# Complete shards skip, and curl is not invoked.
$case = New-Sandbox
$dest = Join-Path $case "dest"
Set-Bytes (Join-Path $dest "$QwenDir/$Shard1Name") $Shard1Min
Set-Bytes (Join-Path $dest "$QwenDir/$Shard2Name") $Shard2Min
$fake = Join-Path $case "fake-curl"
$log = New-FakeCurl -Dir $fake -ExitCode 0
$skipped = Invoke-DownloadScript -Root $case -ArgumentList @("-Dest", $dest, "-Only", "qwen") -FakeCurlDir $fake
if ($skipped.Output -like "*SKIP (already present*" -and $skipped.Output -notlike "*Fetching*Qwen*" -and -not (Test-Path -LiteralPath $log)) {
  Pass "both shards at the published size are skipped"
} else {
  $logged = ""
  if (Test-Path -LiteralPath $log) { $logged = Get-Content -LiteralPath $log -Raw }
  Fail "both shards at the published size are skipped" ($skipped.Output + $logged)
}

# -Migrate still moves a complete legacy copy and does not download it.
$case = New-Sandbox
$dest = Join-Path $case "dest"
Set-Bytes (Join-Path $case "models/$QwenDir/$Shard1Name") $Shard1Min
Set-Bytes (Join-Path $case "models/$QwenDir/$Shard2Name") $Shard2Min
$fake = Join-Path $case "fake-curl"
$log = New-FakeCurl -Dir $fake -ExitCode 0
$migrated = Invoke-DownloadScript -Root $case -ArgumentList @("-Dest", $dest, "-Only", "qwen", "-Migrate") -FakeCurlDir $fake
$moved1 = Join-Path $dest "$QwenDir/$Shard1Name"
$moved2 = Join-Path $dest "$QwenDir/$Shard2Name"
$legacyDir = Join-Path $case "models/$QwenDir"
if ((Test-Path -LiteralPath $moved1) -and (Test-Path -LiteralPath $moved2) -and -not (Test-Path -LiteralPath $legacyDir) -and -not (Test-Path -LiteralPath $log)) {
  Pass "-Migrate moves a complete legacy Qwen download"
} else {
  Fail "-Migrate moves a complete legacy Qwen download" $migrated.Output
}

$source = Get-Content -LiteralPath $ScriptPath -Raw
$canCallHelpers = $source.Contains("function Normalize-Path") -and $source.Contains("function Download-File") -and $source.Contains("InvocationName -eq '.'")
if (-not $canCallHelpers) {
  Fail "Normalize-Path and Download-File are defined and dot-sourceable" ""
} else {
  $unitRoot = New-Sandbox
  $unitScript = Join-Path $unitRoot "unit.ps1"
  $unitBody = @'
$ErrorActionPreference = "Stop"
. $env:MYNA_DOWNLOAD_SCRIPT
$drive = Normalize-Path "\\?\C:\Users\tester\myna\models"
if ($drive -ne "C:\Users\tester\myna\models") { throw "drive prefix stayed: [$drive]" }
$unc = Normalize-Path "\\?\UNC\server\share\models"
if ($unc -ne "\\server\share\models") { throw "UNC prefix stayed: [$unc]" }
$plain = Normalize-Path "C:\Users\tester\myna\models"
if ($plain -ne "C:\Users\tester\myna\models") { throw "plain path changed: [$plain]" }
$plainUnc = Normalize-Path "\\server\share\models"
if ($plainUnc -ne "\\server\share\models") { throw "plain UNC changed: [$plainUnc]" }
if (Normalize-Path "") { throw "empty path changed" }
if (Normalize-Path $null) { throw "null path changed" }
Write-Output "NORMALIZE_OK"

$env:PATH = $env:MYNA_FAIL_CURL + [IO.Path]::PathSeparator + $env:PATH
$failed = $false
try {
  Download-File "https://example.invalid/model" (Join-Path $env:MYNA_UNIT_ROOT "should-not-exist.bin")
} catch {
  if ($_.Exception.Message -notmatch "curl failed with exit code 9") { throw }
  $failed = $true
}
if (-not $failed) { throw "nonzero curl should throw" }
Write-Output "CURL_FAIL_OK"

$env:PATH = $env:MYNA_QUIET_PATH
$outFile = Join-Path $env:MYNA_UNIT_ROOT "hello.bin"
Download-File $env:MYNA_HELLO_URL $outFile
$got = [System.IO.File]::ReadAllText($outFile)
if ($got -ne "hello-from-iwr") { throw "fallback download mismatch: [$got]" }
Write-Output "IWR_OK"
'@
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($unitScript, $unitBody, $utf8)

  $web = Join-Path $unitRoot "web"
  New-Item -ItemType Directory -Force -Path $web | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $web "hello.txt"), "hello-from-iwr", $utf8)
  $listener = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
  $server = Start-Process -FilePath python3 -ArgumentList @("-m", "http.server", "$port", "--bind", "127.0.0.1") -WorkingDirectory $web -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 400
  try {
    $failCurl = Join-Path $unitRoot "fail-curl"
    New-FakeCurl -Dir $failCurl -ExitCode 9 | Out-Null
    $quietParts = $env:PATH -split [IO.Path]::PathSeparator | Where-Object { $_ -and ($_ -ne $failCurl) }
    $env:MYNA_DOWNLOAD_SCRIPT = $ScriptPath
    $env:MYNA_FAIL_CURL = $failCurl
    $env:MYNA_QUIET_PATH = ($quietParts -join [IO.Path]::PathSeparator)
    $env:MYNA_UNIT_ROOT = $unitRoot
    $env:MYNA_HELLO_URL = "http://127.0.0.1:$port/hello.txt"
    $unitOut = & pwsh -NoProfile -File $unitScript 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0 -and $unitOut -match "NORMALIZE_OK" -and $unitOut -match "CURL_FAIL_OK" -and $unitOut -match "IWR_OK") {
      Pass "Normalize-Path strips verbatim prefixes and Download-File falls back"
    } else {
      Fail "Normalize-Path strips verbatim prefixes and Download-File falls back" $unitOut
    }
  } finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item Env:MYNA_DOWNLOAD_SCRIPT, Env:MYNA_FAIL_CURL, Env:MYNA_QUIET_PATH, Env:MYNA_UNIT_ROOT, Env:MYNA_HELLO_URL -ErrorAction SilentlyContinue
  }
}

if ($failures -ne 0) {
  Write-Output "$failures failing check(s)"
  exit 1
}
Write-Output "ok"
