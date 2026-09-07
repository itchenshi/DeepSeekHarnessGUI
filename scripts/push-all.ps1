# push-all.ps1 -- push current branch + tags to GitHub / Gitee / GitCode
#
# Usage:
#   pwsh -File scripts/push-all.ps1
#   powershell.exe -File scripts\push-all.ps1
#   powershell -File scripts/push-all.ps1 -SecretsFile C:\path\push-credentials.txt
#   powershell -File scripts/push-all.ps1 -NoTags
#
# Credentials:
#   - Secrets file is KEY=VALUE lines: GITEE_TOKEN=xxx / GITCODE_TOKEN=xxx / GITHUB_TOKEN=xxx
#   - When a token exists, it is injected as https://<user>:<token>@<host> for that push only
#     (never written into git config and never stored in a remote URL).
#   - Remotes without a token fall back to the git credential manager / interactive prompt.
#   - NEVER commit the secrets file into any repository; revoke tokens after use.

param(
  [string]$SecretsFile = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'push-credentials.txt'),
  [switch]$NoTags
)

$ErrorActionPreference = 'Stop'

$remotes = @(
  @{ Name = 'origin';  Url = 'https://github.com/itchenshi/DeepSeekHarnessGUI.git' },
  @{ Name = 'gitee';   Url = 'https://gitee.com/itchenshi/DeepSeekHarnessGUI.git' },
  @{ Name = 'gitcode'; Url = 'https://gitcode.com/itchenshi/DeepSeekHarnessGUI.git' }
)

# Load secrets (KEY=VALUE lines)
$secrets = @{}
if (Test-Path $SecretsFile) {
  Get-Content $SecretsFile |
    Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*=' } |
    ForEach-Object {
      $kv = $_ -split '=', 2
      $secrets[$kv[0].Trim()] = $kv[1].Trim()
    }
  Write-Host "[info] secrets loaded: $SecretsFile" -ForegroundColor Green
}
else {
  Write-Host "[warn] no secrets file: $SecretsFile (remotes without tokens use credential manager / prompt)" -ForegroundColor Yellow
}

$branch = git rev-parse --abbrev-ref HEAD
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($branch)) { throw 'cannot resolve current branch' }

$tagNote = 'all tags'
if ($NoTags) { $tagNote = 'no tags' }
Write-Host "[plan] push branch: $branch ($tagNote)" -ForegroundColor Cyan

foreach ($r in $remotes) {
  $tokenKey = "$($r.Name)_TOKEN"
  $userKey  = "$($r.Name)_USER"
  $url = $r.Url

  if ($secrets.ContainsKey($tokenKey) -and $secrets[$tokenKey]) {
    $user = $r.Name
    if ($secrets.ContainsKey($userKey) -and $secrets[$userKey]) { $user = $secrets[$userKey] }
    $url = $url -replace '^https://', "https://$user`:$($secrets[$tokenKey])@"
    Write-Host "[push] -> $($r.Name) (https + token)" -ForegroundColor Cyan
  }
  else {
    Write-Host "[push] -> $($r.Name) (https; credential manager / interactive)" -ForegroundColor Cyan
  }

  git push $url $branch
  if ($LASTEXITCODE -ne 0) { throw "push failed: $($r.Name) branch $branch" }

  if (-not $NoTags) {
    git push $url --tags
    if ($LASTEXITCODE -ne 0) { throw "push failed: $($r.Name) tags" }
  }
}

Write-Host "[done] pushed to GitHub / Gitee / GitCode" -ForegroundColor Green