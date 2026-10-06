// Bun workspaces hoist dependencies to the repository root. Metro watches the
// root so `@solus/contracts` and `@solus/client-core` resolve from source.
const fs = require('node:fs')
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')
const { withUniwindConfig } = require('uniwind/metro')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)
config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]
// The shared packages export `./src/*.ts`; the server and Svelte packages must
// never enter the native bundle (tests/unit/native-mobile-boundaries.test.ts).
config.resolver.blockList = [
  /\/packages\/server\/.*/,
  /\/packages\/workspace-ui\/.*/,
  /\/apps\/(desktop|client|site|cli)\/.*/,
]

// T3 Code's Shiki resolution: the app pins shiki 4.2.0 while the desktop
// packages hoist a newer one to the root, so every `@shikijs/*` import resolves
// from this app's shiki and the bundle holds one consistent copy.
const mobileShikiRoot = path.dirname(require.resolve('shiki/package.json', { paths: [projectRoot] }))
const resolveShikiDependencyRoot = (packageName) => {
  let currentDir = path.dirname(require.resolve(packageName, { paths: [mobileShikiRoot] }))
  while (!fs.existsSync(path.join(currentDir, 'package.json'))) {
    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) throw new Error(`Could not resolve package root for ${packageName}`)
    currentDir = parentDir
  }
  return currentDir
}
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  shiki: mobileShikiRoot,
  '@shikijs/core': resolveShikiDependencyRoot('@shikijs/core'),
  '@shikijs/engine-javascript': resolveShikiDependencyRoot('@shikijs/engine-javascript'),
  '@shikijs/engine-oniguruma': resolveShikiDependencyRoot('@shikijs/engine-oniguruma'),
  '@shikijs/langs': resolveShikiDependencyRoot('@shikijs/langs'),
  '@shikijs/themes': resolveShikiDependencyRoot('@shikijs/themes'),
  '@shikijs/types': resolveShikiDependencyRoot('@shikijs/types'),
  '@shikijs/vscode-textmate': resolveShikiDependencyRoot('@shikijs/vscode-textmate'),
}

// T3 Code's styling system: uniwind with a 14px rem (see global.css).
module.exports = withUniwindConfig(config, {
  cssEntryFile: './global.css',
  dtsFile: './uniwind-types.d.ts',
  polyfills: { rem: 14 },
})
