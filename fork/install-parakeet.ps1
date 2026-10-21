# Downloads Parakeet TDT 0.6b v3 for T3 Code dictation, without Scrawl or Hex.
# Run outside the VPN/proxy:  powershell -ExecutionPolicy Bypass -File install-parakeet.ps1
# The model lands where Scrawl would put it, so T3 Code finds it on the next dictation.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$name = 'parakeet-tdt-0.6b-v3-Q8_0.gguf'
$url = "https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf/resolve/main/$name"
$sha256 = '5859f77944efcd8eafa23a6350731960b2b55b2203df51f319665c807d802cc7'

$dir = Join-Path $env:LOCALAPPDATA 'Scrawl\models'
$target = Join-Path $dir $name
# T3 Code only loads *.gguf files, so a half-finished download is never picked up.
$partial = "$target.partial"

function Test-Model($path) {
  (Get-FileHash -Algorithm SHA256 $path).Hash.ToLower() -eq $sha256
}

New-Item -ItemType Directory -Force -Path $dir | Out-Null

if ((Test-Path $target) -and (Test-Model $target)) {
  Write-Host "Already installed: $target"
  exit 0
}

Write-Host "Downloading $name (~740 MB) to $dir ..."
# curl.exe ships with Windows 10+ and resumes an interrupted download with -C -.
& curl.exe --fail --location --retry 5 --continue-at - --output $partial $url
if ($LASTEXITCODE -ne 0) { throw "Download failed (curl exit code $LASTEXITCODE)." }

Write-Host 'Verifying checksum ...'
if (-not (Test-Model $partial)) {
  Remove-Item $partial
  throw 'Checksum mismatch; the download was deleted. Run the script again.'
}
Move-Item -Force $partial $target

Write-Host "Installed: $target"
Write-Host 'Press the dictation button (or F9) in T3 Code. No restart needed.'
