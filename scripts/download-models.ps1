# Windows mirror of scripts/download-models.sh: same -Dest/-Only selectors over
# the same marker files, so model_init.rs drives either script interchangeably.
param(
  [string]$Dest = "",
  [ValidateSet("", "parakeet", "qwen", "vad", "diarization")]
  [string]$Only = "",
  [switch]$Migrate,
  [switch]$Check
)
$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1 redraws a progress bar per packet inside
# Invoke-WebRequest, which caps multi-GB downloads at a few hundred KB/s.
$ProgressPreference = "SilentlyContinue"

# Published sizes of the Q4_K_M shards (Hugging Face
# Qwen/Qwen2.5-7B-Instruct-GGUF). A shorter file is a partial download.
$QwenDirName = "qwen2.5-7b-instruct"
$QwenShard1Name = "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf"
$QwenShard2Name = "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf"
$QwenShard1MinBytes = [int64]3993201344
$QwenShard2MinBytes = [int64]689872288

# Join-Path treats the \\?\ prefix from Rust canonicalization as a path
# whose drive is null. \\?\UNC\server\share becomes \\server\share.
function Normalize-Path([string]$Path) {
  if (-not $Path) { return $Path }
  if ($Path.StartsWith("\\?\UNC\")) { return "\\" + $Path.Substring(8) }
  if ($Path.StartsWith("\\?\")) { return $Path.Substring(4) }
  return $Path
}

function Download-File([string]$Url, [string]$OutFile) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    # -q is first so a curlrc cannot put another protocol back on the allow-list.
    & $curl.Source -q --proto "=https" --proto-redir "=https" -fSL -C - --retry 3 --retry-delay 2 -o $OutFile $Url
    if ($LASTEXITCODE -ne 0) {
      throw "curl failed with exit code $LASTEXITCODE for $Url"
    }
    return
  }
  # Write beside the destination. A failed request must not replace a shard
  # that is already on disk; the rename happens only after the body is complete.
  $part = "$OutFile.part"
  try {
    Invoke-WebRequest -Uri $Url -OutFile $part
    Move-Item -LiteralPath $part -Destination $OutFile -Force
  } catch {
    Remove-Item -LiteralPath $part -ErrorAction SilentlyContinue
    throw
  }
}

function Test-QwenShardsComplete([string]$Dir) {
  $part1 = Join-Path $Dir $QwenShard1Name
  $part2 = Join-Path $Dir $QwenShard2Name
  if (-not (Test-Path -LiteralPath $part1) -or -not (Test-Path -LiteralPath $part2)) {
    return $false
  }
  $part1Bytes = (Get-Item -LiteralPath $part1).Length
  $part2Bytes = (Get-Item -LiteralPath $part2).Length
  return ($part1Bytes -ge $QwenShard1MinBytes) -and ($part2Bytes -ge $QwenShard2MinBytes)
}

function Fetch-One([string]$Name, [string]$DirName, [string]$MarkerRel, [scriptblock]$Fetch) {
  $destDir = Join-Path $Dest $DirName
  $marker = Join-Path $destDir $MarkerRel
  $isQwen = $DirName -eq $QwenDirName
  if ($isQwen) {
    if (Test-QwenShardsComplete $destDir) {
      Write-Output "SKIP (already present: $marker) - $Name"
      return
    }
  } elseif (Test-Path $marker) {
    Write-Output "SKIP (already present: $marker) - $Name"
    return
  }
  $legacyDir = Join-Path $LegacyDest $DirName
  $legacyReady = if ($isQwen) {
    Test-QwenShardsComplete $legacyDir
  } else {
    Test-Path (Join-Path $legacyDir $MarkerRel)
  }
  # migrate refuses to replace a destination directory that already exists,
  # so a partial Qwen download has to be resumed instead of stopping here.
  $resumePartial = $isQwen -and (Test-Path $destDir)
  if ((-not $resumePartial) -and ($destDir -ne $legacyDir) -and $legacyReady) {
    if ($Migrate) {
      New-Item -ItemType Directory -Force -Path (Split-Path $destDir -Parent) | Out-Null
      Move-Item $legacyDir $destDir
    } else {
      Write-Output "Found existing $Name weights under the repo models dir; pass -Migrate to move it to $destDir"
    }
    return
  }
  Write-Output "Fetching $Name ..."
  & $Fetch
}
# tar.exe ships bsdtar on Windows, so -xjf handles .tar.bz2 with no extra tools.
function Expand-TarBz2([string]$Tarball, [string]$Target) { tar -xjf $Tarball -C $Target }
function Fetch-Parakeet {
  Fetch-One "Parakeet STT v3" "parakeet-tdt-0.6b-v3-int8" "encoder.int8.onnx" {
    $d = Join-Path $Dest "parakeet-tdt-0.6b-v3-int8"
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    foreach ($f in @("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")) {
      Download-File "$ParakeetBase/$f" (Join-Path $d $f)
    }
  }
}
# curl -o truncates its destination before the first byte. A shard that
# already meets the published size must not be passed to Download-File.
function Save-QwenShard([string]$Dir, [string]$Name, [int64]$MinBytes) {
  $out = Join-Path $Dir $Name
  if ((Test-Path -LiteralPath $out) -and ((Get-Item -LiteralPath $out).Length -ge $MinBytes)) {
    Write-Output "SKIP shard (already complete: $out)"
    return
  }
  Download-File "$QwenBase/$Name" $out
}
function Fetch-Qwen {
  Fetch-One "Qwen2.5-7B-Instruct GGUF" $QwenDirName $QwenShard1Name {
    $d = Join-Path $Dest $QwenDirName
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    Save-QwenShard $d $QwenShard1Name $QwenShard1MinBytes
    Save-QwenShard $d $QwenShard2Name $QwenShard2MinBytes
  }
}
function Fetch-Vad {
  Fetch-One "silero VAD" "silero-vad" "silero_vad.onnx" {
    $d = Join-Path $Dest "silero-vad"
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    Download-File $VadUrl (Join-Path $d "silero_vad.onnx")
  }
}
function Fetch-Pyannote {
  Fetch-One "pyannote speaker segmentation (diarization, optional)" "pyannote-segmentation-3-0" "sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx" {
    $d = Join-Path $Dest "pyannote-segmentation-3-0"
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $t = Join-Path $d "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
    Download-File $PyannoteUrl $t
    Expand-TarBz2 $t $d
  }
}
function Fetch-Titanet {
  Fetch-One "NeMo TitaNet speaker embedding (diarization, optional)" "nemo-titanet" "nemo_en_titanet_small.onnx" {
    $d = Join-Path $Dest "nemo-titanet"
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    Download-File $TitanetUrl (Join-Path $d "nemo_en_titanet_small.onnx")
  }
}
function Fetch-Eres2net {
  Fetch-One "Wespeaker ERes2Net speaker embedding (diarization, optional, experimental)" "wespeaker-eres2net" "sherpa-onnx-wespeaker-eres2net/model.onnx" {
    $d = Join-Path $Dest "wespeaker-eres2net"
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $t = Join-Path $d "sherpa-onnx-wespeaker-eres2net.tar.bz2"
    try { Download-File $Eres2netUrl $t }
    catch { Write-Output "SKIP ERes2Net (download unavailable) - keeping NeMo TitaNet default"; Remove-Item $t -ErrorAction SilentlyContinue; return }
    Expand-TarBz2 $t $d
    $lic = Get-ChildItem $d -Filter "LICENSE*" -Recurse | Select-Object -First 1
    if ((-not $lic) -or ((Get-Content $lic.FullName -Raw) -notmatch "(?i)MIT license|Apache(-2\.0| License.*2\.0)")) {
      Write-Output "ERROR: ERes2Net license is not MIT/Apache-2.0 - aborting ERes2Net fetch, keeping NeMo TitaNet default"
      Remove-Item (Join-Path $d "sherpa-onnx-wespeaker-eres2net") -Recurse -Force -ErrorAction SilentlyContinue
      Remove-Item $t -ErrorAction SilentlyContinue
      exit 1
    }
  }
}

# Dot-sourcing (the tests) loads the functions above and stops before any
# download. powershell -File keeps going.
if ($MyInvocation.InvocationName -eq '.') { return }

$ScriptDir = Normalize-Path $PSScriptRoot
if (-not $ScriptDir) {
  $commandPath = Normalize-Path $MyInvocation.MyCommand.Path
  if ($commandPath) {
    $ScriptDir = Split-Path -Parent $commandPath
  }
}
$RepoRoot = if ($ScriptDir) { Split-Path $ScriptDir -Parent } else { (Get-Location).Path }

$Dest = Normalize-Path $Dest
if (-not $Dest) {
  if ($env:MYNA_MODELS_DIR) { $Dest = Normalize-Path $env:MYNA_MODELS_DIR }
  else { $Dest = Join-Path $env:USERPROFILE "myna\models" }
}
$LegacyDest = Join-Path $RepoRoot "models"
$ParakeetBase = "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main"
$QwenBase = "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main"
$VadUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
$PyannoteUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
$TitanetUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx"
$Eres2netUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/sherpa-onnx-wespeaker-eres2net.tar.bz2"
if ($Check) {
  $failed = $false
  foreach ($m in @(
    "parakeet-tdt-0.6b-v3-int8/encoder.int8.onnx",
    "qwen2.5-7b-instruct/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
    "qwen2.5-7b-instruct/qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf",
    "silero-vad/silero_vad.onnx")) {
    $p = Join-Path $Dest $m
    if (Test-Path $p) { Write-Output "OK    $p" } else { Write-Output "MISSING $p"; $failed = $true }
  }
  foreach ($m in @(
    "pyannote-segmentation-3-0/sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx",
    "nemo-titanet/nemo_en_titanet_small.onnx",
    "wespeaker-eres2net/sherpa-onnx-wespeaker-eres2net/model.onnx")) {
    $p = Join-Path $Dest $m
    if (Test-Path $p) { Write-Output "OK    $p (optional - speaker diarization)" }
    else { Write-Output "MISSING $p (optional - speaker diarization; app works without it)" }
  }
  if ($failed) { exit 1 } else { exit 0 }
}
switch ($Only) {
  "" { Fetch-Parakeet; Fetch-Qwen; Fetch-Vad }
  "parakeet" { Fetch-Parakeet }
  "qwen" { Fetch-Qwen }
  "vad" { Fetch-Vad }
  "diarization" { Fetch-Pyannote; Fetch-Titanet; Fetch-Eres2net }
}
