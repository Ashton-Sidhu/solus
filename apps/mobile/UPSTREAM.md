# Mobile source

This workspace contains the T3 mobile app, its workspace dependencies, native inputs and licenses. T3 Code is distributed under the MIT license in `LICENSE`. The source comes from `https://github.com/pingdotgg/t3code.git`. The initial Solus integration used upstream commit `194025ef11027c95b0d226a4d2bbdafb92279eab`.

`SOURCE_PATHS` lists paths in the upstream checkout. Files from upstream's `apps/mobile/` go directly in this folder. Other upstream paths stay relative to this folder. The workspace and app manifests share one `package.json`, and the app is the root importer in `pnpm-lock.yaml`. `SOLUS_FORK_REVISION` records the fork revision used for the original import.

Make Solus mobile changes here. See `AGENTS.md` for the frontend and backend integration rules. Installation and tests use the source in this repository.

For an upstream update, compare the new T3 revision with the previous import over the paths in `SOURCE_PATHS`. Apply the relevant changes in an isolated Solus checkout. Keep the production app identity, the local `solus-core` import, the LAN module, and these workspace instructions. Review changes to the native package manifest, native inputs, patches and workspace dependencies. Install with the frozen lockfile, run the mobile checks and export both native bundles. Record the tested revision with the update.
