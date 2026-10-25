import { expect, test } from 'bun:test'
import { win32 } from 'node:path'
import { findWindowsCommand, resolveWindowsCommand, shimTarget, type CommandFiles } from '@solus/server/cli-env'

// A Windows disk as a list of files, so these run on every platform.
function disk(files: Record<string, string>): CommandFiles {
  const contents = new Map(Object.entries(files).map(([file, text]) => [file.toLowerCase(), text]))
  return {
    names(dir) {
      const prefix = `${dir.toLowerCase().replace(/\\$/, '')}\\`
      const names = [...contents.keys()].filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('\\'))
      return names.length ? new Set(names.map((file) => file.slice(prefix.length))) : null
    },
    read: (file) => contents.get(file.toLowerCase()) ?? null,
    exists: (file) => contents.has(win32.normalize(file).toLowerCase()),
  }
}

const NPM_SCRIPT_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n')

const NPM_BINARY_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\tool\\bin\\tool.exe"   %*',
].join('\r\n')

const NODE_NPM_CMD = [
  ':: Created by npm, please don\'t edit manually.',
  '@ECHO OFF',
  'SETLOCAL',
  'SET "NODE_EXE=%~dp0\\node.exe"',
  'IF NOT EXIST "%NODE_EXE%" (',
  '  SET "NODE_EXE=node"',
  ')',
  'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
  '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
].join('\r\n')

test('a bare name finds the program before a shim, in PATHEXT order', () => {
  // WHY: a bare name on Windows means one of the PATHEXT files. Looking for the
  // name alone found nothing, so git, claude, and codex were all "not installed".
  const files = disk({ 'C:\\tools\\codex.cmd': NPM_SCRIPT_SHIM, 'C:\\tools\\codex.exe': '' })
  expect(findWindowsCommand('codex', 'C:\\tools', '.COM;.EXE;.BAT;.CMD', files)).toBe('C:\\tools\\codex.exe')
})

test('a drive letter is not a PATH separator, and quoted and repeated folders are read once', () => {
  // WHY: the POSIX lookup split `C:\Program Files` at its colon.
  const files = disk({ 'C:\\Program Files\\Git\\cmd\\git.exe': '' })
  const path = 'c:\\program files\\git\\CMD;"C:\\Program Files\\Git\\cmd";;'
  expect(findWindowsCommand('GIT', path, undefined, files)).toBe('c:\\program files\\git\\CMD\\git.exe')
})

test('an npm shim for a script starts Node with the script', () => {
  // WHY: Node refuses to spawn a .cmd without a shell, and through cmd.exe an
  // argument with a quote or a line break breaks the command line.
  const files = disk({
    'C:\\npm\\codex.cmd': NPM_SCRIPT_SHIM,
    'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js': '',
    'C:\\node\\node.exe': '',
  })
  expect(resolveWindowsCommand('codex', 'C:\\npm;C:\\node', undefined, files)).toEqual({
    file: 'C:\\node\\node.exe',
    args: ['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'],
  })
})

test('a script shim prefers the Node beside it, as the shim does', () => {
  const files = disk({
    'C:\\nodejs\\npm.cmd': NODE_NPM_CMD,
    'C:\\nodejs\\node.exe': '',
    'C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js': '',
    'C:\\other\\node.exe': '',
  })
  expect(resolveWindowsCommand('npm', 'C:\\other;C:\\nodejs', undefined, files)).toEqual({
    file: 'C:\\nodejs\\node.exe',
    args: ['C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'],
  })
})

test('an npm shim for a native program starts the program itself', () => {
  const files = disk({ 'C:\\npm\\tool.cmd': NPM_BINARY_SHIM, 'C:\\npm\\node_modules\\tool\\bin\\tool.exe': '' })
  expect(resolveWindowsCommand('tool', 'C:\\npm', undefined, files)).toEqual({ file: 'C:\\npm\\node_modules\\tool\\bin\\tool.exe', args: [] })
})

test('a shim Solus cannot read is a miss, not a shell command', () => {
  // WHY: running an unknown .cmd means running it through cmd.exe, which this resolver never does.
  const files = disk({ 'C:\\bin\\tool.cmd': '@echo off\r\ncall something-else %*', 'C:\\node\\node.exe': '' })
  expect(resolveWindowsCommand('tool', 'C:\\bin;C:\\node', undefined, files)).toBeNull()
})

test('a shim whose target is gone is a miss', () => {
  const files = disk({ 'C:\\npm\\codex.cmd': NPM_SCRIPT_SHIM, 'C:\\node\\node.exe': '' })
  expect(resolveWindowsCommand('codex', 'C:\\npm;C:\\node', undefined, files)).toBeNull()
})

test("Git for Windows' launcher is replaced by the real git", () => {
  // WHY: each start of `cmd\git.exe` leaks a kernel token, and process creation slows as they pile up.
  const files = disk({
    'C:\\Program Files\\Git\\cmd\\git.exe': '',
    'C:\\Program Files\\Git\\ucrt64\\bin\\git.exe': '',
  })
  expect(resolveWindowsCommand('git', 'C:\\Program Files\\Git\\cmd', undefined, files)).toEqual({ file: 'C:\\Program Files\\Git\\ucrt64\\bin\\git.exe', args: [] })
})

test('the launcher stays when no real git is beside it', () => {
  const files = disk({ 'C:\\Git\\cmd\\git.exe': '' })
  expect(resolveWindowsCommand('git', 'C:\\Git\\cmd', undefined, files)).toEqual({ file: 'C:\\Git\\cmd\\git.exe', args: [] })
})

test('a shim target fills in the shim folder and its own variables', () => {
  expect(shimTarget(NODE_NPM_CMD, 'D:\\node')).toBe('D:\\node\\node_modules\\npm\\bin\\npm-cli.js')
  expect(shimTarget('@echo off', 'D:\\node')).toBeNull()
})
