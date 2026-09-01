const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

const productionDeps = new Set([
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/claude-agent-sdk-darwin-arm64',
  '@anthropic-ai/claude-agent-sdk-darwin-x64',
  '@anthropic-ai/claude-agent-sdk-linux-arm64',
  '@anthropic-ai/claude-agent-sdk-linux-arm64-musl',
  '@anthropic-ai/claude-agent-sdk-linux-x64',
  '@anthropic-ai/claude-agent-sdk-linux-x64-musl',
  '@anthropic-ai/claude-agent-sdk-win32-arm64',
  '@anthropic-ai/claude-agent-sdk-win32-x64',
  '@anthropic-ai/sdk',
  '@babel/runtime',
  '@hono/node-server',
  '@modelcontextprotocol/sdk',
  'accepts',
  'ajv',
  'ajv-formats',
  'body-parser',
  'bytes',
  'call-bind-apply-helpers',
  'call-bound',
  'content-disposition',
  'content-type',
  'cookie',
  'cookie-signature',
  'cors',
  'cross-spawn',
  'debug',
  'depd',
  'dunder-proto',
  'ee-first',
  'encodeurl',
  'es-define-property',
  'es-errors',
  'es-object-atoms',
  'escape-html',
  'etag',
  'eventsource',
  'eventsource-parser',
  'express',
  'express-rate-limit',
  'fast-deep-equal',
  'fast-uri',
  'finalhandler',
  'forwarded',
  'fresh',
  'function-bind',
  'get-intrinsic',
  'get-proto',
  'gopd',
  'has-symbols',
  'hasown',
  'hono',
  'http-errors',
  'iconv-lite',
  'inherits',
  'ip-address',
  'ipaddr.js',
  'is-promise',
  'isexe',
  'jose',
  'json-schema-to-ts',
  'json-schema-traverse',
  'json-schema-typed',
  'math-intrinsics',
  'media-typer',
  'merge-descriptors',
  'mime-db',
  'mime-types',
  'ms',
  'negotiator',
  'object-assign',
  'object-inspect',
  'on-finished',
  'once',
  'parseurl',
  'path-key',
  'path-to-regexp',
  'pkce-challenge',
  'proxy-addr',
  'qs',
  'range-parser',
  'raw-body',
  'require-from-string',
  'router',
  'safer-buffer',
  'send',
  'serve-static',
  'setprototypeof',
  'shebang-command',
  'shebang-regex',
  'side-channel',
  'side-channel-list',
  'side-channel-map',
  'side-channel-weakmap',
  'statuses',
  'toidentifier',
  'ts-algebra',
  'type-is',
  'unpipe',
  'vary',
  'which',
  'wrappy',
  'zod',
  'zod-to-json-schema',
]);

const productionScopes = new Set(
  [...productionDeps]
    .filter(d => d.startsWith('@'))
    .map(d => d.split('/')[0])
);

module.exports = {
  packagerConfig: {
    name: 'Solus',
    asar: true,
    ignore: (filePath) => {
      if (filePath === '') return false;
      if (filePath === '/package.json') return false;
      if (filePath.startsWith('/dist')) return false;
      if (filePath.startsWith('/resources')) return false;
      if (filePath === '/node_modules') return false;
      if (filePath.startsWith('/node_modules/')) {
        const rel = filePath.slice('/node_modules/'.length);
        const parts = rel.split('/');
        let pkgName = parts[0];
        if (pkgName.startsWith('@')) {
          if (!parts[1]) return !productionScopes.has(pkgName);
          pkgName = `${pkgName}/${parts[1]}`;
        }
        return !productionDeps.has(pkgName);
      }
      return true;
    },
    icon: 'resources/icon',
    appBundleId: 'com.solus.app',
    extendInfo: {
      NSMicrophoneUsageDescription: 'Solus uses your microphone to transcribe voice input locally with Whisper.',
    },
    // Code signing — requires "Developer ID Application" cert in Keychain
    osxSign: {
      identity: 'Developer ID Application',
      'hardened-runtime': true,
      entitlements: 'resources/entitlements.mac.plist',
      'entitlements-inherit': 'resources/entitlements.mac.plist',
      'signature-flags': 'library',
    },
    // Notarization — reads credentials from env vars (see .env or export before running)
    // Required env vars:
    //   APPLE_ID                    — your Apple ID email
    //   APPLE_APP_SPECIFIC_PASSWORD — app-specific password from appleid.apple.com
    //   APPLE_TEAM_ID               — your 10-char Team ID from developer.apple.com/account
    osxNotarize: {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    }
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {},
    },
    // Produces a signed & notarized .dmg for macOS distribution
    {
      name: '@electron-forge/maker-dmg',
      config: {
        format: 'ULFO',
        icon: 'resources/icon.icns',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
