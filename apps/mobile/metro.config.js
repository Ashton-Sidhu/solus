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

// T3 Code's Shiki resolution, for the highlighting fallback of a binary without
// modules/solus-highlights (src/lib/shikiHighlights.ts): the app pins shiki
// 4.2.0 while the desktop packages can hoist a newer one to the root, so every
// `@shikijs/*` import resolves from this app's shiki and the bundle holds one
// consistent copy.
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

// T3 Code imports single `@pierre/diffs` utilities by path, as its patched
// package exports them. The published package exports only its root, which
// would pull in the whole web renderer and Shiki's language bundle, so these
// paths resolve to the built files. `tsconfig.json` maps the same paths.
// The package exports neither `package.json` nor a `require` entry, so
// `require.resolve` cannot find it; look in the module folders Metro reads.
const pierreDiffsDist = config.resolver.nodeModulesPaths
  .map((modules) => path.join(modules, '@pierre/diffs/dist'))
  .find((dist) => fs.existsSync(dist))
const resolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const pierreUtility = /^@pierre\/diffs\/(utils\/[\w-]+)$/.exec(moduleName)
  if (pierreUtility) return { type: 'sourceFile', filePath: path.join(pierreDiffsDist, `${pierreUtility[1]}.js`) }
  return (resolveRequest ?? context.resolveRequest)(context, moduleName, platform)
}

// T3 Code's styling system: uniwind with a 14px rem (see global.css).
module.exports = withUniwindConfig(config, {
  cssEntryFile: './global.css',
  dtsFile: './uniwind-types.d.ts',
  polyfills: { rem: 14 },
})
