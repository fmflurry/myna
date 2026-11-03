# Pester coverage for per-shard Qwen downloads.
# Invoke with: pwsh -NoProfile -Command "Invoke-Pester -Path scripts/download-models.Pester.ps1 -CI"
#Requires -Modules Pester

BeforeAll {
  $script:DownloadScript = Join-Path $PSScriptRoot "download-models.ps1"
  $script:Shard1Name = "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf"
  $script:Shard2Name = "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf"
  $script:Shard1Min = [int64]3993201344
  $script:Shard2Min = [int64]689872288
  $script:QwenDir = "qwen2.5-7b-instruct"

  function script:New-SparseFile([string]$Path, [int64]$Length) {
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $stream = [System.IO.File]::Open(
      $Path,
      [System.IO.FileMode]::Create,
      [System.IO.FileAccess]::Write)
    try { $stream.SetLength($Length) } finally { $stream.Dispose() }
  }
}

Describe "Qwen shard downloads" {
  It "does not download a part 1 already at the size floor when part 2 is short" {
    $root = Join-Path ([System.IO.Path]::GetTempPath()) ("myna-pester-" + [guid]::NewGuid().ToString("n"))
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    try {
      $dest = Join-Path $root "dest"
      $part1 = Join-Path $dest "$QwenDir/$Shard1Name"
      $part2 = Join-Path $dest "$QwenDir/$Shard2Name"
      New-SparseFile $part1 $Shard1Min
      New-SparseFile $part2 ($Shard2Min - 1)
      $seen = [System.Collections.Generic.List[string]]::new()
      & {
        param($DownloadScript, $ModelsDest, $Seen)
        . $DownloadScript
        function Download-File([string]$Url, [string]$OutFile) {
          $Seen.Add($OutFile)
        }
        $Dest = $ModelsDest
        $LegacyDest = Join-Path $ModelsDest "legacy-absent"
        $QwenBase = "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main"
        Fetch-Qwen | Out-Null
      } $DownloadScript $dest $seen
      $seen -join "`n" | Should -Not -BeLike "*$Shard1Name*"
      $seen -join "`n" | Should -BeLike "*$Shard2Name*"
      (Get-Item -LiteralPath $part1).Length | Should -Be $Shard1Min
    } finally {
      Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  It "keeps an existing file when Invoke-WebRequest fails after opening its output" {
    $root = Join-Path ([System.IO.Path]::GetTempPath()) ("myna-pester-" + [guid]::NewGuid().ToString("n"))
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    try {
      $out = Join-Path $root "shard.bin"
      [System.IO.File]::WriteAllText($out, "keep-me")
      $quiet = Join-Path $root "path"
      New-Item -ItemType Directory -Force -Path $quiet | Out-Null
      $previousPath = $env:PATH
      & {
        param($DownloadScript, $Out, $QuietPath)
        $env:PATH = $QuietPath
        . $DownloadScript
        function Invoke-WebRequest {
          param($Uri, $OutFile)
          [System.IO.File]::WriteAllText($OutFile, "partial")
          throw "network down"
        }
        { Download-File "https://example.invalid/shard.bin" $Out } | Should -Throw
      } $DownloadScript $out $quiet
      $env:PATH = $previousPath
      [System.IO.File]::ReadAllText($out) | Should -Be "keep-me"
      Test-Path -LiteralPath "$out.part" | Should -BeFalse
    } finally {
      if ($previousPath) { $env:PATH = $previousPath }
      Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
