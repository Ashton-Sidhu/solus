// Bun workspaces hoist dependencies to the repository root. Metro watches the
// root so `@solus/contracts` and `@solus/client-core` resolve from source.
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

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

module.exports = config
