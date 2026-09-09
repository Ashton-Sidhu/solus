const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// electron-builder's Arch enum, which `context.arch` reports as an ordinal.
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

const PROBE_TIMEOUT_MS = 30_000

/**
 * Runs inside the packaged app in node mode. `argv[1]` is the fff entry point
 * inside app.asar; `argv[2]` is a scratch directory to index.
 *
 * `findBinary()` is the function our fff-node patch rewrites: unpatched, it
 * hands back the path inside app.asar, which cannot be dlopen'd. Asserting the
 * path *and* constructing a finder covers both halves — a wrong path and a
 * right path whose native library was never unpacked.
 */
const FFF_PROBE_SOURCE = `
const { pathToFileURL } = await import('node:url')
const { sep } = await import('node:path')
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
`

/**
 * Fails the build when the packaged app cannot load fff's native library.
 *
 * The library lives in app.asar.unpacked, but fff resolves it from its own
 * location inside app.asar; `patches/@ff-labs%2Ffff-node@0.9.6.patch` redirects
 * that lookup. Nothing in dev exercises the patch — an unpacked checkout has no
 * archive to resolve out of — so a bad rebase stays invisible until file search
 * is dead in a shipped build. This runs the real resolution against the real
 * archive instead.
 *
 * Must run before `flipFuses`: the RunAsNode fuse we disable below is what
 * `ELECTRON_RUN_AS_NODE` needs, so afterwards the app can only boot its GUI.
 */
function probePackagedFff(context, appPath) {
  const archName = ARCH_NAMES[context.arch]
  if (context.electronPlatformName !== process.platform || archName !== process.arch) {
    console.log(`[afterPack] fff probe skipped: cannot run ${context.electronPlatformName}/${archName} on this host`)
    return
  }

  const resourcesDir = path.join(appPath, 'Contents', 'Resources')
  const unpackedNatives = path.join(
    resourcesDir,
    'app.asar.unpacked',
    'node_modules',
    '@ff-labs',
    `fff-bin-${context.electronPlatformName}-${archName}`
  )
  if (!fs.existsSync(unpackedNatives)) {
    throw new Error(`[afterPack] fff native library was not unpacked; expected ${unpackedNatives}. Check the asarUnpack globs in package.json.`)
  }

  const executable = path.join(appPath, 'Contents', 'MacOS', context.packager.appInfo.productFilename)
  const fffEntry = path.join(resourcesDir, 'app.asar', 'node_modules', '@ff-labs', 'fff-node', 'dist', 'src', 'index.js')
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solus-fff-probe-'))

  // ELECTRON_NO_ASAR would let the probe read straight through the archive and
  // mask the very resolution bug it exists to catch.
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' }
  delete env.ELECTRON_NO_ASAR
  delete env.NODE_OPTIONS

  try {
    const output = execFileSync(
      executable,
      ['--no-global-search-paths', '--input-type=module', '--eval', FFF_PROBE_SOURCE, fffEntry, probeRoot],
      { env, timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    console.log(`[afterPack] ${output.trim()}`)
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`[afterPack] the packaged app could not load fff from app.asar. The fff-node patch is likely stale — see patches/@ff-labs%2Ffff-node@0.9.6.patch.\n${detail || err.message}`)
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true })
  }
}

module.exports = async function afterPack(context) {
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )
  probePackagedFff(context, appPath)
  await flipFuses(appPath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  })
}
