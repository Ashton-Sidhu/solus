# Mobile source

This workspace contains the T3 mobile app, its workspace dependencies, native inputs and licenses. T3 Code is distributed under the MIT license in `LICENSE`. The source comes from `https://github.com/pingdotgg/t3code.git`. The initial Solus integration used upstream commit `194025ef11027c95b0d226a4d2bbdafb92279eab`.

`SOURCE_PATHS` lists the imported paths. `SOLUS_FORK_REVISION` records the local `solus-mobile` revision used for the import. Source files and both lockfiles are in this repository. A fresh checkout can build without the separate development fork.

For an update, compare the recorded fork revision with the tested fork tip over the imported paths. Apply that delta to this workspace in an isolated Solus checkout. Keep the primary production identity, the local `solus-core` import, the LAN module, and these workspace instructions. Review changes to the native package manifest, native inputs, patches and workspace dependency graph before updating the path list. Install with the frozen lockfile, run the mobile checks and export both native bundles. Record the tested revision together with the update.
