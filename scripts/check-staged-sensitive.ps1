param(
  [switch]$AllowNoGit
)

$ErrorActionPreference = 'Stop'

$blockedPatterns = @(
  '^node_modules/',
  '^\.next/',
  '^out/',
  '^\.agents/',
  '^\.codex/',
  '^tmp/',
  '^uploads/',
  '^jobs/',
  '^tmp_extracted/',
  '^tmp_orig_extracted/',
  '^tmp_sat_orig_extracted/',
  '^tmp_.*\.zip$',
  '^\.env(\..*)?$',
  '\.pem$',
  '\.key$',
  '\.p12$',
  '\.pfx$',
  '\.crt$',
  '\.cer$',
  '(^|/).*secret.*',
  '(^|/).*credential.*',
  '(^|/).*token.*',
  '(^|/)serviceAccount.*\.json$'
)

try {
  $stagedFiles = git diff --cached --name-only --diff-filter=ACMR
} catch {
  if ($AllowNoGit) {
    Write-Host 'Git repository not available; skipped staged-file safety check.'
    exit 0
  }

  Write-Error 'Git repository not available. Run this check inside the project repository.'
  exit 1
}

$blocked = @()
foreach ($file in $stagedFiles) {
  $normalized = $file -replace '\\', '/'
  foreach ($pattern in $blockedPatterns) {
    if ($normalized -match $pattern) {
      $blocked += $normalized
      break
    }
  }
}

if ($blocked.Count -gt 0) {
  Write-Host ''
  Write-Host 'Blocked commit: sensitive/runtime files are staged.' -ForegroundColor Red
  Write-Host 'Unstage these files before committing:' -ForegroundColor Yellow
  $blocked | Sort-Object -Unique | ForEach-Object { Write-Host " - $_" }
  Write-Host ''
  Write-Host 'Tip: git restore --staged <path>' -ForegroundColor Yellow
  exit 1
}

Write-Host 'Staged-file safety check passed.'
