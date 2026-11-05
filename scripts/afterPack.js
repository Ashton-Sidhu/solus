const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')
const { packageLayout } = require('./desktop-package-layout.cjs')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// electron-builder's Arch enum, which `context.arch` reports as an ordinal.
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

const PROBE_TIMEOUT_MS = 30_000
const MAX_MAC_ARM64_APP_BYTES = 600_000_000

/**
 * Runs inside the packaged app in node mode. Arguments are the fff entry point,
 * a scratch directory and the Claude SDK entry point.
 *
 * `findBinary()` is the function our fff-node patch rewrites: unpatched, it
 * hands back the path inside app.asar, which cannot be dlopen'd. Asserting the
 * path *and* constructing a finder covers both halves — a wrong path and a
 * right path whose native library was never unpacked.
 */
const RUNTIME_PROBE_SOURCE = `
const { pathToFileURL } = await import('node:url')
const { sep, dirname, join } = await import('node:path')
const { readdirSync } = await import('node:fs')
const fff = await import(pathToFileURL(process.argv[1]).href)
const binaryPath = fff.findBinary()
if (!binaryPath) throw new Error('findBinary() resolved nothing inside the packaged app')
if (binaryPath.includes('.asar' + sep) && !binaryPath.includes('.asar.unpacked'))
  throw new Error('findBinary() resolved into the asar archive instead of its unpacked sibling: ' + binaryPath)
const created = fff.FileFinder.create({
  basePath: process.argv[2],
  disableWatch: true,
  disableMmapCache: true,
  disableContentIndexing: true,
})
if (!created.ok) throw new Error('FileFinder.create failed: ' + String(created.error))
created.value.destroy()
console.log('fff-probe-ok ' + binaryPath)

const sdk = await import(pathToFileURL(process.argv[3]).href)
if (typeof sdk.query !== 'function') throw new Error('Packaged Claude SDK could not load')
const anthropicPackages = readdirSync(join(dirname(process.argv[3]), '..'))
if (anthropicPackages.some(name => name.startsWith('claude-agent-sdk-')))
  throw new Error('Bundled Claude executable packages must not ship; setup installs Claude on the host')
console.log('claude-sdk-probe-ok')
`

/**
 * Fails the build when the packaged native libraries or Claude SDK cannot load.
 *
 * The library lives in app.asar.unpacked, but fff resolves it from its own
 * location inside app.asar; `patches/@ff-labs%2Ffff-node@0.11.0.patch` redirects
 * that lookup. Nothing in dev exercises the patch — an unpacked checkout has no
 * archive to resolve out of — so a bad rebase stays invisible until file search
 * is dead in a shipped build. This runs the real resolution against the real
 * archive instead.
 *
 * Must run before `flipFuses`: the RunAsNode fuse we disable below is what
 * `ELECTRON_RUN_AS_NODE` needs, so afterwards the app can only boot its GUI.
 */
function probePackagedRuntime(context) {
  const archName = ARCH_NAMES[context.arch]
  if (context.electronPlatformName !== process.platform || archName !== process.arch) {
    console.log(`[afterPack] runtime probe skipped: cannot run ${context.electronPlatformName}/${archName} on this host`)
    return
  }

  const { resourcesDir, executable } = packageLayout(context)
  const unpackedNatives = path.join(
    resourcesDir,
    'app.asar.unpacked',
    'node_modules',
    '@ff-labs',
    `fff-bin-${context.electronPlatformName}-${archName}${context.electronPlatformName === "linux" ? "-gnu" : ""}`
  )
  if (!fs.existsSync(unpackedNatives)) {
    throw new Error(`[afterPack] fff native library was not unpacked; expected ${unpackedNatives}. Check the asarUnpack globs in package.json.`)
  }

  const fffEntry = path.join(resourcesDir, 'app.asar', 'node_modules', '@ff-labs', 'fff-node', 'dist', 'index.js')
  const claudeEntry = path.join(resourcesDir, 'app.asar', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs')
  const voiceBinary = path.join(resourcesDir, 'transcription', process.platform === 'win32' ? 'solus-transcription.exe' : 'solus-transcription')
  const voiceVersion = execFileSync(voiceBinary, ['--probe'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS })
  if (!voiceVersion.startsWith('solus-transcription/1 transcribe.cpp/'))
    throw new Error('[afterPack] Packaged voice runtime failed its protocol check')
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solus-runtime-probe-'))

  // ELECTRON_NO_ASAR would let the probe read straight through the archive and
  // mask the very resolution bug it exists to catch.
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '', SOLUS_DATA_DIR: probeRoot }
  delete env.ELECTRON_NO_ASAR
  delete env.NODE_OPTIONS

  try {
    const output = execFileSync(
      executable,
      ['--no-global-search-paths', '--input-type=module', '--eval', RUNTIME_PROBE_SOURCE, fffEntry, probeRoot, claudeEntry],
      { env, timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    console.log(`[afterPack] ${output.trim()}`)
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`[afterPack] packaged runtime validation failed. Check the native file filters, asarUnpack, and fff-node patch.\n${detail || err.message}`)
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true })
  }
}

function directoryBytes(directory) {
  let bytes = 0
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) bytes += directoryBytes(entryPath)
    else if (entry.isFile()) bytes += fs.statSync(entryPath).size
  }
  return bytes
}

module.exports = async function afterPack(context) {
  const { appPath, fusePath } = packageLayout(context)
  const bytes = directoryBytes(appPath)
  console.log(`[afterPack] app size: ${(bytes / 1_000_000).toFixed(1)} MB`)
  if (context.electronPlatformName === 'darwin' && ARCH_NAMES[context.arch] === 'arm64' && bytes > MAX_MAC_ARM64_APP_BYTES) {
    throw new Error('[afterPack] Mac ARM64 app exceeds 600 MB. Check for bundled CLIs, duplicate renderer packages, or non-target native libraries.')
  }
  probePackagedRuntime(context)
  await flipFuses(fusePath, {
    version: FuseVersion.V1,
    // The Windows app's `solus` command runs its CLI through ELECTRON_RUN_AS_NODE
    // (docs/plans/windows.md §5.12). macOS keeps it off: there any script could
    // borrow the Microphone, Screen Recording, and keychain grants given to Solus.
    // Linux has no `solus` command from the app yet, so it stays off there too.
    [FuseV1Options.RunAsNode]: context.electronPlatformName === 'win32',
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: context.electronPlatformName !== 'linux',
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  })
}
