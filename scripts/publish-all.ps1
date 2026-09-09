# publish-all.ps1 -- three-platform release: push code, build this platform's
# artifacts, then publish the release + assets to GitHub / Gitee / GitCode.
#
# Flow:
#   1. (optional) push current branch + tags to GitHub / Gitee / GitCode
#      (re-uses push-all.ps1; skip with -NoPush)
#   2. (optional) build artifacts for the current platform
#      (npm run dist:win|mac|linux; skip with -NoBuild; force with -Platform)
#   3. (optional) create a release tagged v<package.json version> on GitHub,
#      Gitee and GitCode, and upload every artifact in dist/
#      (skip with -NoRelease)
#
# Usage:
#   powershell -File scripts/publish-all.ps1
#   powershell -File scripts/publish-all.ps1 -NoPush
#   powershell -File scripts/publish-all.ps1 -NoBuild
#   powershell -File scripts/publish-all.ps1 -NoRelease
#   powershell -File scripts/publish-all.ps1 -Platform win|mac|linux
#   powershell -File scripts/publish-all.ps1 -SecretsFile C:\path\push-credentials.txt
#   powershell -File scripts/publish-all.ps1 -NotesFile CHANGELOG.md
#
# Credentials (push-credentials.txt, same file as push-all.ps1):
#   GITHUB_TOKEN=xxx / GITEE_TOKEN=xxx / GITCODE_TOKEN=xxx
# Platforms without a token are skipped for publish (push phase falls back to
# the credential manager). NEVER commit the secrets file.

param(
  [string]$SecretsFile = '',
  [ValidateSet('', 'win', 'mac', 'linux')][string]$Platform = '',
  [switch]$NoPush,
  [switch]$NoBuild,
  [switch]$NoRelease,
  [string]$NotesFile = ''
)

$ErrorActionPreference = 'Stop'
# scripts/ lives directly under the repo root.
$RepoRoot = Split-Path $PSScriptRoot -Parent
$DistDir = Join-Path $RepoRoot 'dist'
# Secrets file defaults next to the repo (same convention as push-all.ps1:
# <parent of repo>/push-credentials.txt, outside the repository).
$DefaultSecrets = Join-Path (Split-Path $RepoRoot -Parent) 'push-credentials.txt'
if (-not $SecretsFile) { $SecretsFile = $DefaultSecrets }

function Write-Step([string]$msg) { Write-Host "[publish] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "[ok]     $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "[warn]   $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------- platform --
function Get-CurrentPlatform {
  if ($IsWindows -or $env:OS -like 'Windows*') { return 'win' }
  if ($IsMacOS) { return 'mac' }
  if ($IsLinux) { return 'linux' }
  $u = uname -s 2>$null
  if ($u -like 'Darwin*') { return 'mac' }
  if ($u -like 'Linux*') { return 'linux' }
  return 'win'
}

$platform = $Platform
if (-not $platform) { $platform = Get-CurrentPlatform }
Write-Step "target platform: $platform"

# -------------------------------------------------------------- secrets ----
$secrets = @{}
if (Test-Path $SecretsFile) {
  Get-Content $SecretsFile |
    Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*=' } |
    ForEach-Object {
      $kv = $_ -split '=', 2
      $secrets[$kv[0].Trim()] = $kv[1].Trim()
    }
  Write-Ok "secrets loaded: $SecretsFile"
}
else {
  Write-Warn "no secrets file: $SecretsFile (publish phase will skip token-less platforms)"
}

# ---------------------------------------------------------------- version ----
$package = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
$tag = "v$version"
$releaseName = "DSH GUI $version"
Write-Step "version: $version (release tag: $tag)"

# ---------------------------------------------------------------- push -----
if (-not $NoPush) {
  Write-Step 'pushing branch + tags to GitHub / Gitee / GitCode'
  & powershell.exe -NoProfile -File (Join-Path $PSScriptRoot 'push-all.ps1') -SecretsFile $SecretsFile
  if ($LASTEXITCODE -ne 0) { throw 'push-all.ps1 failed' }
  Write-Ok 'pushed to all three remotes'
}
else {
  Write-Warn 'skipping push (-NoPush)'
}

# ensure the tag exists for the release phase (create locally if absent)
if (git -C $RepoRoot rev-parse -q --verify "refs/tags/$tag") {
  Write-Ok "tag $tag already exists"
}
else {
  Write-Step "creating tag $tag locally"
  git -C $RepoRoot tag "$tag"
  if (-not $NoPush) { git -C $RepoRoot push origin "$tag" }
}

# ---------------------------------------------------------------- build ----
if (-not $NoBuild) {
  $script = switch ($platform) {
    'win'   { 'dist:win' }
    'mac'   { 'dist:mac' }
    'linux' { 'dist:linux' }
  }
  Write-Step "building artifacts (npm run $script)"
  Push-Location $RepoRoot
  try {
    & npm.cmd run $script
    if ($LASTEXITCODE -ne 0) { throw "npm run $script failed (exit $LASTEXITCODE)" }
  }
  finally { Pop-Location }
  Write-Ok "build finished for $platform"
}
else {
  Write-Warn 'skipping build (-NoBuild)'
}

# --------------------------------------------------------- collect assets ----
function Get-ReleaseAssets([string]$platform) {
  $patterns = switch ($platform) {
    'win'   { @('*.exe', '*.zip', 'DSH-GUI-WIN*') }
    'mac'   { @('*.dmg', '*.zip', 'DSH-GUI-MAC*') }
    'linux' { @('*.AppImage', '*.zip', 'DSH-GUI-LINUX*') }
  }
  $found = @()
  foreach ($p in $patterns) {
    $found += Get-ChildItem -Path $DistDir -Filter $p -File -ErrorAction SilentlyContinue
  }
  # De-dupe by full name (the per-platform folder zips created by
  # fix-unpacked.mjs are DSH-GUI-WIN.zip / DSH-GUI-MAC.zip / DSH-GUI-LINUX.zip
  # and match the platform patterns too).
  $seen = @{}
  $assets = @()
  foreach ($f in $found) {
    if ($seen.ContainsKey($f.FullName)) { continue }
    $seen[$f.FullName] = $true
    $assets += $f
  }
  return $assets
}

$assets = Get-ReleaseAssets $platform
if (-not $NoRelease -and $assets.Count -eq 0) {
  throw "no release assets found under dist/ for platform '$platform' (build first, or run with -NoBuild when dist/ already has artifacts)"
}

# --------------------------------------------------------------- publish ----
if ($NoRelease) {
  Write-Warn 'skipping release phase (-NoRelease)'
  Write-Ok "done (push+build only). tag: $tag"
  exit 0
}

$notes = ''
if ($NotesFile -and (Test-Path $NotesFile)) {
  $notes = Get-Content $NotesFile -Raw
}
if (-not $notes) {
  $notes = "DSH GUI $version`n`nRelease artifacts: $($assets.Name -join ', ')"
}

function Publish-GiteeLikeRelease {
  param(
    [string]$ApiBase,
    [string]$Owner,
    [string]$Repo,
    [string]$Token,
    [string]$Tag,
    [string]$Name,
    [string]$Body,
    [array]$AssetFiles,
    [string]$Label
  )
  if (-not $Token) { Write-Warn "${Label}: no token, skipping publish"; return }
  $releaseUrl = "$ApiBase/repos/$Owner/$Repo/releases"
  $headers = @{ 'Content-Type' = 'application/json;charset=UTF-8' }
  $payload = @{
    access_token = $Token
    tag_name     = $Tag
    name         = $Name
    body         = $Body
    prerelease   = $false
  } | ConvertTo-Json

  try {
    $release = Invoke-RestMethod -Method Post -Uri $releaseUrl -Headers $headers -Body $payload
    $releaseId = $release.id
    Write-Ok "${Label}: release created (id ${releaseId})"
  }
  catch {
    # Gitee-like APIs return an error when the tag release already exists;
    # reuse the existing release instead of failing the whole run.
    Write-Warn "${Label}: create failed ($($_.Exception.Message)) - trying to reuse existing release"
    try {
      $existing = Invoke-RestMethod -Method Get -Uri $releaseUrl -Headers @{ 'Content-Type' = 'application/json;charset=UTF-8' }
      $releaseId = ($existing | Where-Object { $_.tag_name -eq $Tag } | Select-Object -First 1).id
      if (-not $releaseId) { throw "release $Tag not found on ${Label}" }
      Write-Ok "${Label}: reusing existing release (id ${releaseId})"
    }
    catch {
      throw "${Label}: cannot create or find release $Tag : $($_.Exception.Message)"
    }
  }

  foreach ($asset in $AssetFiles) {
    Write-Step "${Label}: uploading $($asset.Name)"
    $uploadUrl = "$ApiBase/repos/$Owner/$Repo/releases/$releaseId/attach_files"
    $err = & curl.exe -sS -X POST $uploadUrl -F "access_token=$Token" -F "file=@$($asset.FullName)" 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "${Label}: upload failed for $($asset.Name): $err"
    }
    else {
      Write-Ok "${Label}: uploaded $($asset.Name)"
    }
  }
}

function Publish-GitHubRelease {
  param(
    [string]$Owner,
    [string]$Repo,
    [string]$Token,
    [string]$Tag,
    [string]$Name,
    [string]$Body,
    [array]$AssetFiles,
    [string]$Label
  )
  # GitHub-specific: when no token is present, fall back to the GitHub CLI
  # (gh) if it is installed and authenticated, so publish still works.
  $useGh = $false
  if (-not $Token) {
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($gh) {
      gh auth status 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) {
        $useGh = $true
        Write-Warn "${Label}: no API token, using authenticated 'gh' CLI"
      }
      else {
        Write-Warn "${Label}: no token and gh not authenticated - skipping publish"
        return
      }
    }
    else {
      Write-Warn "${Label}: no token and no gh CLI - skipping publish"
      return
    }
  }

  if ($useGh) {
    $assetArgs = @()
    foreach ($a in $AssetFiles) { $assetArgs += $a.FullName }
    # -R owner/repo, create with notes from a temp file to avoid quoting issues
    $notesPath = Join-Path $env:TEMP "gh-notes-$Tag.txt"
    Set-Content -Path $notesPath -Value $Body -Encoding utf8
    try {
      & gh release create $Tag -R "$Owner/$Repo" --title $Name --notes-file $notesPath @assetArgs 2>&1 | ForEach-Object { Write-Step "${Label}: $_" }
      if ($LASTEXITCODE -ne 0) { throw "gh release create failed (exit $LASTEXITCODE)" }
      Write-Ok "${Label}: release $Tag published via gh"
    }
    catch {
      # existing release: try uploading assets to it
      Write-Warn "${Label}: gh create failed ($($_.Exception.Message)) - reusing existing release"
      $upArgs = @()
      foreach ($a in $AssetFiles) { $upArgs += $a.FullName }
      & gh release upload $Tag -R "$Owner/$Repo" --clobber @upArgs 2>&1 | ForEach-Object { Write-Step "${Label}: $_" }
      if ($LASTEXITCODE -ne 0) { throw "gh release upload failed (exit $LASTEXITCODE)" }
      Write-Ok "${Label}: assets uploaded to existing release $Tag"
    }
    finally {
      Remove-Item $notesPath -Force -ErrorAction SilentlyContinue
    }
    return
  }

  $headers = @{
    Authorization  = "Bearer $Token"
    Accept         = 'application/vnd.github+json'
    'Content-Type' = 'application/json;charset=UTF-8'
  }
  $payload = @{
    tag_name   = $Tag
    name       = $Name
    body       = $Body
    draft      = $false
    prerelease = $false
  } | ConvertTo-Json

  $releaseUrl = "https://api.github.com/repos/$Owner/$Repo/releases"
  $releaseId = $null
  try {
    $release = Invoke-RestMethod -Method Post -Uri $releaseUrl -Headers $headers -Body $payload
    $releaseId = $release.id
    Write-Ok "${Label}: release created (id ${releaseId})"
  }
  catch {
    Write-Warn "${Label}: create failed ($($_.Exception.Message)) - looking for existing release"
    try {
      $list = Invoke-RestMethod -Method Get -Uri $releaseUrl -Headers $headers -ErrorAction Stop
      $existing = $list | Where-Object { $_.tag_name -eq $Tag } | Select-Object -First 1
      if (-not $existing) { throw 'not found' }
      $releaseId = $existing.id
      Write-Ok "${Label}: reusing existing release (id ${releaseId})"
    }
    catch {
      throw "${Label}: cannot create or find release ${Tag}: $($_.Exception.Message)"
    }
  }

  foreach ($asset in $AssetFiles) {
    Write-Step "${Label}: uploading $($asset.Name)"
    $safeName = [uri]::EscapeDataString($asset.Name)
    $uploadUrl = "https://uploads.github.com/repos/$Owner/$Repo/releases/$releaseId/assets?name=$safeName"
    $uplHeaders = @{
      Authorization  = "Bearer $Token"
      Accept         = 'application/vnd.github+json'
      'Content-Type' = 'application/octet-stream'
    }
    try {
      $null = Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $uplHeaders -InFile $asset.FullName
      Write-Ok "${Label}: uploaded $($asset.Name)"
    }
    catch {
      Write-Warn "${Label}: upload failed for $($asset.Name): $($_.Exception.Message)"
    }
  }
}

$owner = 'itchenshi'
$repo  = 'DeepSeekHarnessGUI'

Write-Step "publishing release $tag to GitHub / Gitee / GitCode"
Write-Ok "assets: $($assets.Name -join ', ')"

Publish-GitHubRelease -Owner $owner -Repo $repo -Token $secrets['GITHUB_TOKEN'] `
  -Tag $tag -Name $releaseName -Body $notes -AssetFiles $assets -Label 'GitHub'

Publish-GiteeLikeRelease -ApiBase 'https://gitee.com/api/v5' -Owner $owner -Repo $repo `
  -Token $secrets['GITEE_TOKEN'] -Tag $tag -Name $releaseName -Body $notes `
  -AssetFiles $assets -Label 'Gitee'

Publish-GiteeLikeRelease -ApiBase 'https://api.gitcode.com/api/v5' -Owner $owner -Repo $repo `
  -Token $secrets['GITCODE_TOKEN'] -Tag $tag -Name $releaseName -Body $notes `
  -AssetFiles $assets -Label 'GitCode'

Write-Ok "release $tag published (see per-platform results above)"