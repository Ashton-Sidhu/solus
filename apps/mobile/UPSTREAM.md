# Mobile source

This workspace contains the T3 mobile app, its workspace dependencies, native inputs and licenses. T3 Code is distributed under the MIT license in `LICENSE`. The source comes from `https://github.com/pingdotgg/t3code.git`. The initial Solus integration used upstream commit `194025ef11027c95b0d226a4d2bbdafb92279eab`.

`SOURCE_PATHS` lists paths in the upstream checkout. Files from upstream's `apps/mobile/` go directly in this folder. Other upstream paths stay relative to this folder. The workspace and app manifests share one `package.json`, and the app is the root importer in `pnpm-lock.yaml`. `SOLUS_FORK_REVISION` records the fork revision used for the original import.

Make Solus mobile changes here. See `AGENTS.md` for the frontend and backend integration rules. Installation and tests use the source in this repository.

For an upstream update, compare the new T3 revision with the previous import over the paths in `SOURCE_PATHS`. Apply the relevant changes in an isolated Solus checkout. Keep the production app identity, the local `solus-core` import, the LAN module, and these workspace instructions. Review changes to the native package manifest, native inputs, patches and workspace dependencies. Install with the frozen lockfile, run the mobile checks and export both native bundles. Record the tested revision with the update.

The model picker sheet, its catalog filter, and its iOS and Android rows match T3 Code revision `9b7f5eb4479c5287340a863407ad083e2fdbeb7a`. The Solus adapter gives the sheet the host's model groups. The default list hides legacy models unless they are selected or favorited. Search and the Show legacy models filter can include them.

The home session rows and tablet sidebar use the T3 Code row styles and swipe controls checked at `dd19bce823d833b5612fd74851d50047e65347fa`. The row reads its project icon, provider, live status and read state from the Solus host.

Session rows follow T3 Code revision `dd19bce823d833b5612fd74851d50047e65347fa` for the Input and Done indicators and linked pull request badges. The Solus host supplies outstanding questions and completions on connect. A session record supplies its Git links. A later host event updates the badge. A single badge opens the PR and a group opens the linked PR sheet. Solus also shows the session’s recorded Git branch on active and compact rows, even when the session has no linked PR.
