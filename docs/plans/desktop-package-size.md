# Desktop package size

Solus uses the Claude Code installation on the host. Setup handles installation
and sign-in when needed. The desktop app ships the Claude Agent SDK, but excludes
its optional `claude-agent-sdk-*` executable packages.

Every SDK query waits for asynchronous host PATH discovery and checks for an
executable `claude` before starting. A missing executable returns setup guidance.
The executable path is not cached, so installation or removal after startup is
visible to subsequent requests. This applies to turns, slash-command discovery,
usage queries, and file rewind on desktop and standalone hosts. Web and mobile
clients use the same host behavior. Codex behavior is unchanged.

## Package rules

- Renderer-only packages belong in root `devDependencies`. Vite includes their
  runtime code in the desktop and web bundles. Declaring them as production
  dependencies also puts full copies in `app.asar`.
- Keep host runtime dependencies in `dependencies`. Electron-vite externalizes
  these modules, so the packaged server still needs them in `node_modules`.
- Keep the explicit app file allowlist in `build.files`. Add exclusions to that
  same list. An exclusion-only `mac.files` list replaces the allowlist and makes
  electron-builder copy the workspace by default.
- Exclude source maps from release files.
- The current desktop target is macOS ARM64. Keep only the target architecture's
  ONNX binding and `libonnxruntime.1.dylib`, which the binding links to. Exclude
  other operating systems, other architectures, and the duplicate fully versioned
  dylib. A new desktop platform must update these Mac-specific filters.
- Keep both `dist/renderer` and `dist/client`. The desktop host serves remote web
  and mobile clients as well as its local renderer.

## Validation

`scripts/afterPack.js` reports the uncompressed app size and fails Mac ARM64
packaging above 600 MB. This allows room above the measured 436 MB package while
catching a reintroduced CLI or a large packaging error. The limit applies before
release signing, not to the compressed DMG or ZIP.

Before disabling Electron's node-mode fuse, the packaging hook runs the packaged
executable in node mode with a temporary data directory. It checks:

- File search can resolve and load its unpacked native library.
- ONNX can run a small Identity graph with the CPU provider. No speech model or
  user data is required.
- The Claude SDK can load without its optional executable packages.

Run the focused tests with:

```sh
bun run test:unit claude-executable claude-steering desktop-package-files
bun run build
```

The file-filter tests use electron-builder's matcher to check required app files,
excluded workspace data, and native library selection. The Claude tests cover
PATH discovery, missing installations, installation and removal after startup,
all query entry points, and cancellation during PATH discovery.

## Measurement on 2026-09-09

The installed v0.30.0 app contained 908,409,477 bytes. An unsigned v0.31.0 Mac ARM64
directory build with these changes contained 435,781,186 bytes: approximately 52%
less. This compares two versions, not identical signed release builds.

The new package contained about 288 MB of frameworks, a 98 MB ASAR archive, and
50 MB of unpacked native libraries. Packed JavaScript dependencies fell from
210 MB to 41 MB. Inspection confirmed that both client entries and all server
entries remain present, with no source maps or bundled Claude executables. The
ONNX binary directory contains only the ARM64 binding and its linked dylib.
