/**
 * Custom electron-builder macOS sign hook.
 *
 * electron-builder bundles @electron/osx-sign 1.x, which spawns one `codesign`
 * process per file in the bundle: hundreds of forks for the Electron framework,
 * helpers, locale packs, and unpacked native modules. @electron/osx-sign 2.x can
 * group files that share signing arguments into a single `codesign` call while
 * preserving inside-out seal order, which turns minutes of process-spawn overhead
 * into seconds.
 *
 * electron-builder passes the fully-built sign options (identity, keychain,
 * entitlements, provisioning profile, ignore filter), so this only adds batching.
 * Dynamic import because @electron/osx-sign 2.x is ESM-only and this file is CJS.
 */
module.exports = async function sign(options) {
  const { sign: signApplication } = await import('@electron/osx-sign')
  await signApplication({ ...options, batchCodesignCalls: true })
}
