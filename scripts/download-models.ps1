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
$RepoRoot = Split-Path $PSScriptRoot -Parent
if (-not $Dest) {
  if ($env:MYNA_MODELS_DIR) { $Dest = $env:MYNA_MODELS_DIR }
  else { $Dest = Join-Path $env:USERPROFILE "myna\models" }
}
$LegacyDest = Join-Path $RepoRoot "models"
$ParakeetBase = "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main"
$QwenBase = "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main"
$VadUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
$PyannoteUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
$TitanetUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx"
$Eres2netUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/sherpa-onnx-wespeaker-eres2net.tar.bz2"
function Fetch-One([string]$Name, [string]$DirName, [string]$MarkerRel, [scriptblock]$Fetch) {
  $destDir = Join-Path $Dest $DirName
  $marker = Join-Path $destDir $MarkerRel
  if (Test-Path $marker) { Write-Output "SKIP (already present: $marker) - $Name"; return }
  $legacyDir = Join-Path $LegacyDest $DirName
  if (($destDir -ne $legacyDir) -and (Test-Path (Join-Path $legacyDir $MarkerRel))) {
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
      Invoke-WebRequest -Uri "$ParakeetBase/$f" -OutFile (Join-Path $d $f)
    }
  }
}
function Fetch-Qwen {
  Fetch-One "Qwen2.5-7B-Instruct GGUF" "qwen2.5-7b-instruct" "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf" {
    $d = Join-Path $Dest "qwen2.5-7b-instruct"
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    foreach ($f in @("qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf", "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf")) {
      Invoke-WebRequest -Uri "$QwenBase/$f" -OutFile (Join-Path $d $f)
    }
  }
}
function Fetch-Vad {
  Fetch-One "silero VAD" "silero-vad" "silero_vad.onnx" {
    $d = Join-Path $Dest "silero-vad"
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    Invoke-WebRequest -Uri $VadUrl -OutFile (Join-Path $d "silero_vad.onnx")
  }
}
function Fetch-Pyannote {
  Fetch-One "pyannote speaker segmentation (diarization, optional)" "pyannote-segmentation-3-0" "sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx" {
    $d = Join-Path $Dest "pyannote-segmentation-3-0"
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $t = Join-Path $d "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
    Invoke-WebRequest -Uri $PyannoteUrl -OutFile $t
    Expand-TarBz2 $t $d
  }
}
function Fetch-Titanet {
  Fetch-One "NeMo TitaNet speaker embedding (diarization, optional)" "nemo-titanet" "nemo_en_titanet_small.onnx" {
    $d = Join-Path $Dest "nemo-titanet"
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    Invoke-WebRequest -Uri $TitanetUrl -OutFile (Join-Path $d "nemo_en_titanet_small.onnx")
  }
}
function Fetch-Eres2net {
  Fetch-One "Wespeaker ERes2Net speaker embedding (diarization, optional, experimental)" "wespeaker-eres2net" "sherpa-onnx-wespeaker-eres2net/model.onnx" {
    $d = Join-Path $Dest "wespeaker-eres2net"
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $t = Join-Path $d "sherpa-onnx-wespeaker-eres2net.tar.bz2"
    try { Invoke-WebRequest -Uri $Eres2netUrl -OutFile $t }
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
