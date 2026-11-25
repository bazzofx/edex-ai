# eDEX AI setup (Windows, PowerShell). Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
# Installs Node dependencies, Python voice dependencies, and checks models/voices.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

Write-Host "== Node.js dependencies" -ForegroundColor Cyan
node --version
npm install
Push-Location src; npm install; Pop-Location

Write-Host "== Python voice dependencies" -ForegroundColor Cyan
python --version
python -m pip install --user -r voice\requirements.txt

Write-Host "== Speech-to-text model (faster-whisper 'base', ~150 MB, downloaded once)" -ForegroundColor Cyan
python -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8'); print('whisper base ready')"

Write-Host "== Piper voice" -ForegroundColor Cyan
$voiceDir = Join-Path $env:APPDATA "eDEX AI\voices"
New-Item -ItemType Directory -Force -Path $voiceDir | Out-Null
$existing = Get-ChildItem -Path $voiceDir -Filter *.onnx -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Voice found: $($existing[0].Name)"
} else {
    Write-Host "Downloading Piper voice en_US-ryan-high (~120 MB) into $voiceDir"
    python -m piper.download_voices en_US-ryan-high --download-dir "$voiceDir"
}

Write-Host "== OpenRouter API key" -ForegroundColor Cyan
$key = [Environment]::GetEnvironmentVariable("apiOpenRouterEDEXAI", "User")
if ($key) { Write-Host "apiOpenRouterEDEXAI is set (user scope)." }
else { Write-Host "Not set. Create a key at https://openrouter.ai/keys, then run:" -ForegroundColor Yellow
       Write-Host '  [Environment]::SetEnvironmentVariable("apiOpenRouterEDEXAI", "<your key>", "User")' }

Write-Host "== Tests" -ForegroundColor Cyan
npm test
Write-Host "`nDone. Start with: npm start" -ForegroundColor Green
