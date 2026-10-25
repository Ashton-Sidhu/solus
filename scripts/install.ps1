# Installer for the Solus standalone server on Windows. It is the Windows form
# of install.sh and needs only Windows PowerShell 5.1.
#
# It downloads the packaged release (Node + server + CLI), verifies its
# checksum, and installs it as an immutable version in the runtime folder:
#
#   %LOCALAPPDATA%\solus\runtime\versions\<version>\   one install per version
#   %LOCALAPPDATA%\solus\runtime\current               junction to the active version
#   %USERPROFILE%\.local\bin\solus.cmd                 stable launcher; never version-specific
#
# `solus update` and the remote update RPC point `current` at a new version
# the same way (docs/plans/host-and-provider-updates.md, docs/plans/windows.md §5.7).
#
# Run it:
#   irm https://github.com/Ashton-Sidhu/solus/releases/latest/download/install.ps1 | iex
# With flags:
#   & ([scriptblock]::Create((irm <url>))) -Link CODE
#
# Env overrides (mainly to test a release that is not published):
#   SOLUS_VERSION             install this exact version, not the latest release
#   SOLUS_INSTALL_ARCHIVE     path to a downloaded zip; skips the download
#   SOLUS_INSTALL_SHA256SUMS  path to that zip's SHA256SUMS; required with the above
#   SOLUS_RUNTIME_DIR         overrides %LOCALAPPDATA%\solus\runtime
#   SOLUS_BIN_DIR             overrides %USERPROFILE%\.local\bin
#   SOLUS_RELEASE_REPO        overrides Ashton-Sidhu/solus
#
# Flags:
#   -Setup            run `solus setup` after the install
#   -Link CODE        run `solus setup --link CODE`: start the logon task and
#                     link this host to Solus Cloud with a code from onboarding
#   -CloudUrl URL     the Solus Cloud origin that issued the code

param(
  [switch]$Setup,
  [string]$Link = '',
  [string]$CloudUrl = ''
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 shows a progress bar that makes a download many times slower.
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 can default to TLS 1.0, which GitHub refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Get-SolusTarget {
  # A 32-bit PowerShell on a 64-bit machine reports x86 in PROCESSOR_ARCHITECTURE
  # and the real one in PROCESSOR_ARCHITEW6432, so read that first.
  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    'AMD64' { return 'win32-x64' }
    'ARM64' { throw 'Solus builds the Windows server for x64 only. Windows on ARM is not supported.' }
    default { throw "Unsupported architecture: $arch. Solus builds the Windows server for x64 only." }
  }
}

function Get-SolusVersion([string]$Repo) {
  if ($env:SOLUS_VERSION) { return $env:SOLUS_VERSION }
  $release = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$Repo/releases/latest"
  return ($release.tag_name -replace '^v', '')
}

function Assert-Sha256([string]$File, [string]$SumsFile, [string]$Artifact) {
  $expected = $null
  foreach ($line in Get-Content -LiteralPath $SumsFile) {
    $parts = $line.Trim() -split '\s+'
    if ($parts.Count -ge 2 -and $parts[1] -eq $Artifact) { $expected = $parts[0]; break }
  }
  if (-not $expected) { throw "SHA256SUMS did not contain $Artifact" }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash
  # -ne compares without case: Get-FileHash gives upper case, SHA256SUMS lower case.
  if ($actual -ne $expected) { throw "Checksum mismatch for $Artifact (expected $expected, got $actual)" }
}

# Check an unpacked release before it becomes a version: its manifest, its
# files, and that its own Node runs its own CLI.
function Assert-Release([string]$Dir, [string]$Version) {
  $manifest = Get-Content -Raw -LiteralPath (Join-Path $Dir 'server-release.json') | ConvertFrom-Json
  if ($manifest.version -ne $Version) { throw 'Release version mismatch' }
  foreach ($file in @('bin\node.exe', 'bin\solus.cmd', 'libexec\server\standalone.js', 'libexec\cli\solus.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Dir $file) -PathType Leaf)) { throw "The release has no $file" }
  }
  $printed = & (Join-Path $Dir 'bin\node.exe') (Join-Path $Dir 'libexec\cli\solus.js') --version
  if ($LASTEXITCODE -ne 0) { throw "The release CLI did not start (exit code $LASTEXITCODE)" }
  if ("$printed".Trim() -ne $Version) { throw "The release CLI reports version $printed, not $Version" }
}

# Point `current` at the version. A junction needs no administrator rights,
# where a directory symlink does. An old junction is removed, never its
# target: Directory.Delete on a reparse point removes only the link.
function Set-CurrentVersion([string]$RuntimeDir, [string]$VersionDir) {
  $current = Join-Path $RuntimeDir 'current'
  $old = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
  if ($old) {
    if (-not ($old.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$current is a folder, not a link. Remove it and run the installer again." }
    [IO.Directory]::Delete($current)
  }
  New-Item -ItemType Junction -Path $current -Target $VersionDir | Out-Null
}

# The stable command. It hands over to the active version's launcher without
# `call`, so cmd.exe does not come back to it and the exit code is solus's.
function Write-Launcher([string]$BinDir, [string]$RuntimeDir, [bool]$IsDefaultRuntime) {
  # The default folder stays a variable, so a user name with non-ASCII letters
  # is not written into a file that cmd.exe reads in the OEM code page.
  $runtime = if ($IsDefaultRuntime) { '%LOCALAPPDATA%\solus\runtime' } else { $RuntimeDir.Replace('%', '%%') }
  $text = "@echo off`r`n" +
    "setlocal`r`n" +
    "if not defined SOLUS_RUNTIME_DIR set `"SOLUS_RUNTIME_DIR=$runtime`"`r`n" +
    "`"%SOLUS_RUNTIME_DIR%\current\bin\solus.cmd`" %*`r`n"
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  [IO.File]::WriteAllText((Join-Path $BinDir 'solus.cmd'), $text, (New-Object Text.UTF8Encoding $false))
}

# Add the command folder to the user PATH, which needs no administrator
# rights. A new terminal reads it; this one gets it now for -Setup.
function Add-UserPath([string]$BinDir) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @()
  if ($userPath) { $entries = $userPath -split ';' | Where-Object { $_ } }
  $present = $entries | Where-Object { $_.TrimEnd('\') -eq $BinDir.TrimEnd('\') }
  if (-not $present) {
    [Environment]::SetEnvironmentVariable('Path', (@($entries) + $BinDir) -join ';', 'User')
    Write-Host ''
    Write-Host "Added $BinDir to your user PATH. Open a new terminal to use solus."
  }
  if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -eq $BinDir.TrimEnd('\') })) {
    $env:Path = "$BinDir;$env:Path"
  }
}

function Invoke-SolusSetup([string]$BinDir) {
  $setupArgs = @('setup')
  if ($Link) { $setupArgs += @('--link', $Link) }
  if ($CloudUrl) { $setupArgs += @('--cloud-url', $CloudUrl) }
  Write-Host ''
  & (Join-Path $BinDir 'solus.cmd') @setupArgs
  if ($LASTEXITCODE -ne 0) { throw "solus setup failed (exit code $LASTEXITCODE)" }
}

function Install-Solus {
  $defaultRuntime = Join-Path $env:LOCALAPPDATA 'solus\runtime'
  $runtimeDir = if ($env:SOLUS_RUNTIME_DIR) { $env:SOLUS_RUNTIME_DIR } else { $defaultRuntime }
  $binDir = if ($env:SOLUS_BIN_DIR) { $env:SOLUS_BIN_DIR } else { Join-Path $env:USERPROFILE '.local\bin' }
  $repo = if ($env:SOLUS_RELEASE_REPO) { $env:SOLUS_RELEASE_REPO } else { 'Ashton-Sidhu/solus' }
  $runSetup = $Setup -or [bool]$Link

  if (Test-Path -LiteralPath (Join-Path $runtimeDir 'current')) {
    # A second run with a link code still links: the code is the point.
    if (-not $runSetup) { throw 'Solus is already installed. Use solus update.' }
    Write-Host 'Solus is already installed.'
    Invoke-SolusSetup $binDir
    return
  }

  $target = Get-SolusTarget
  $version = Get-SolusVersion $repo
  if (-not $version) { throw 'Could not find a version to install. Set SOLUS_VERSION.' }
  if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version' }
  $artifact = "solus-server-$target.zip"

  $workDir = Join-Path ([IO.Path]::GetTempPath()) "solus-install-$([guid]::NewGuid())"
  New-Item -ItemType Directory -Path $workDir | Out-Null
  try {
    $archive = Join-Path $workDir $artifact
    $sums = Join-Path $workDir 'SHA256SUMS'
    if ($env:SOLUS_INSTALL_ARCHIVE) {
      if (-not $env:SOLUS_INSTALL_SHA256SUMS) { throw 'SOLUS_INSTALL_SHA256SUMS is required with SOLUS_INSTALL_ARCHIVE' }
      Copy-Item -LiteralPath $env:SOLUS_INSTALL_ARCHIVE -Destination $archive
      Copy-Item -LiteralPath $env:SOLUS_INSTALL_SHA256SUMS -Destination $sums
    } else {
      Write-Host "Downloading Solus $version ($target)..."
      Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$repo/releases/download/v$version/$artifact" -OutFile $archive
      Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$repo/releases/download/v$version/SHA256SUMS" -OutFile $sums
    }

    Assert-Sha256 $archive $sums $artifact

    $versionsDir = Join-Path $runtimeDir 'versions'
    $versionDir = Join-Path $versionsDir $version
    if (Test-Path -LiteralPath $versionDir) {
      Write-Host "Solus $version is already installed."
    } else {
      $stageDir = Join-Path $versionsDir ".install-$PID"
      if (Test-Path -LiteralPath $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force }
      New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
      try {
        Expand-Archive -LiteralPath $archive -DestinationPath $stageDir
        Assert-Release $stageDir $version
        Move-Item -LiteralPath $stageDir -Destination $versionDir
      } finally {
        if (Test-Path -LiteralPath $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force }
      }
    }

    Set-CurrentVersion $runtimeDir $versionDir
    Write-Launcher $binDir $runtimeDir (-not $env:SOLUS_RUNTIME_DIR)
  } finally {
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-Host ''
  Write-Host "Installed Solus $version to $versionDir"
  Write-Host "Launcher: $(Join-Path $binDir 'solus.cmd')"
  Add-UserPath $binDir
  if ($runSetup) {
    Invoke-SolusSetup $binDir
    return
  }
  Write-Host ''
  Write-Host 'Next: run `solus setup` to start the server at logon, or `solus start` to run it in this terminal.'
  Write-Host 'Then run `solus pair` and open the link or enter the code on each client.'
}

Install-Solus
