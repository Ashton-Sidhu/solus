import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// WHY: macOS and Linux runners have no Windows PowerShell 5.1, so these checks
// read the script for the decisions in docs/plans/windows.md §5.10 and §6. The
// real proof is a run of install.ps1 on a Windows machine.
const script = readFileSync(join(import.meta.dir, '../../scripts/install.ps1'), 'utf8')

test('a 32-bit PowerShell on a 64-bit machine reads the real architecture, and ARM64 is refused', () => {
  const target = script.slice(script.indexOf('function Get-SolusTarget'), script.indexOf('function Get-SolusVersion'))
  expect(target.indexOf('$env:PROCESSOR_ARCHITEW6432')).toBeGreaterThan(-1)
  expect(target.indexOf('$env:PROCESSOR_ARCHITEW6432')).toBeLessThan(target.indexOf('$env:PROCESSOR_ARCHITECTURE'))
  expect(target).toMatch(/'ARM64' \{ throw '[^']*x64 only[^']*' \}/)
  expect(target).toContain("'AMD64' { return 'win32-x64' }")
})

test('the zip is verified against SHA256SUMS before it is unpacked', () => {
  expect(script).toContain("$artifact = \"solus-server-$target.zip\"")
  expect(script).toContain('Get-FileHash -Algorithm SHA256')
  expect(script.indexOf('Assert-Sha256 $archive')).toBeLessThan(script.indexOf('Expand-Archive'))
  // As install.sh: local files for a release that is not published.
  expect(script).toContain('$env:SOLUS_INSTALL_ARCHIVE')
  expect(script).toContain("throw 'SOLUS_INSTALL_SHA256SUMS is required with SOLUS_INSTALL_ARCHIVE'")
})

test('a release that does not run never becomes current', () => {
  expect(script).toContain("(Join-Path $Dir 'libexec\\cli\\solus.js') --version")
  expect(script.indexOf('Assert-Release $stageDir')).toBeLessThan(script.indexOf('Set-CurrentVersion $runtimeDir'))
})

test('current is a junction, which needs no administrator rights, and only an old link is removed', () => {
  expect(script).toContain('New-Item -ItemType Junction -Path $current -Target $VersionDir')
  expect(script).toContain('[IO.FileAttributes]::ReparsePoint')
  expect(script).not.toMatch(/RunAsAdministrator|Verb RunAs/)
})

test('the command folder goes on the user PATH, not the machine PATH', () => {
  expect(script).toContain("Join-Path $env:USERPROFILE '.local\\bin'")
  expect(script).toContain("[Environment]::SetEnvironmentVariable('Path', (@($entries) + $BinDir) -join ';', 'User')")
  expect(script).not.toContain("'Machine')")
})

test('it runs on Windows PowerShell 5.1', () => {
  expect(script).toContain("$ErrorActionPreference = 'Stop'")
  expect(script).toContain('[Net.SecurityProtocolType]::Tls12')
  // Invoke-WebRequest in 5.1 needs Internet Explorer without -UseBasicParsing.
  for (const line of script.split('\n').filter((l) => /Invoke-(WebRequest|RestMethod)/.test(l))) {
    expect(line).toContain('-UseBasicParsing')
  }
})
