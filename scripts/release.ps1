<#
.SYNOPSIS
  Build PDF Studio and publish it as a GitHub release the app's updater will pick up.

.DESCRIPTION
  1. Refuses to run if the working tree has uncommitted changes or if the
     version in package.json already has a release tag.
  2. npm run build:win  →  dist\PDF-Studio-Setup-<ver>.exe + dist\latest.yml
  3. git tag v<ver>, push main + tag
  4. gh release create v<ver> with the installer, its blockmap and latest.yml

  Installed apps see the new latest.yml within ~8 s of their next launch (or
  4 h if left open), download the installer, and offer Help → Restart to update.

.PARAMETER Notes
  Release notes shown on GitHub (Markdown). Defaults to the last commit subject.

.PARAMETER SkipBuild
  Reuse what is already in dist\ for this version.

.EXAMPLE
  .\scripts\release.ps1 -Notes "Combine files, header & footer, pictures as pages"
#>
param(
  [string]$Notes = '',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }

# gh is installed per-user by winget; make sure it's reachable in this shell.
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  $env:PATH += ";$env:ProgramFiles\GitHub CLI"
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'GitHub CLI (gh) not found — winget install GitHub.cli' }
gh auth status *> $null
if ($LASTEXITCODE -ne 0) { throw 'Not signed in to GitHub — run: gh auth login' }

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$tag = "v$version"
$repo = 'mitchellloewen/pdfstudio'

Step "Preflight for $tag"
$dirty = git status --porcelain
if ($dirty) { throw "Working tree has uncommitted changes — commit first:`n$dirty" }
if (git tag -l $tag) { throw "$tag already exists — bump the version in package.json first (a released version is never rebuilt)" }
gh release view $tag -R $repo *> $null
if ($LASTEXITCODE -eq 0) { throw "Release $tag already exists on GitHub" }

$exe = "dist\PDF-Studio-Setup-$version.exe"
$yml = 'dist\latest.yml'

if (-not $SkipBuild) {
  Step 'Building installer'
  npm run build:win
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }
}
foreach ($f in @($exe, "$exe.blockmap", $yml)) {
  if (-not (Test-Path $f)) { throw "missing build output: $f" }
}
$ymlVersion = (Select-String -Path $yml -Pattern '^version:\s*(\S+)').Matches[0].Groups[1].Value
if ($ymlVersion -ne $version) { throw "latest.yml says $ymlVersion but package.json says $version" }

if (-not $Notes) { $Notes = (git log -1 --pretty=%s) }

Step "Tagging $tag and pushing main"
git tag -a $tag -m "PDF Studio $version"
git push origin main
git push origin $tag

Step "Creating GitHub release $tag"
gh release create $tag $exe "$exe.blockmap" $yml -R $repo --title "PDF Studio $version" --notes $Notes
if ($LASTEXITCODE -ne 0) { throw 'gh release create failed — the tag is pushed; fix and re-run with -SkipBuild' }

$size = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "`nPublished $tag ($size MB). Installed copies will update themselves; new users: https://github.com/$repo/releases/latest" -ForegroundColor Green
