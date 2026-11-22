# Solus mobile

The primary Solus app for iOS and Android uses the T3 Code interface. The files are tracked in Solus under `vendor/t3code`. The repository entry point is `apps/mobile`.

## Run locally

From the Solus repository root, install both workspaces. The native workspace uses the versions of React Native and the native patches in its own pnpm lockfile.

```sh
bun install
bun run mobile:install
cd -P apps/mobile
APP_VARIANT=development npx expo run:ios
```

For Android use `APP_VARIANT=development npx expo run:android`. For a production native build use `APP_VARIANT=production`. The production bundle and Android package use `sh.solus.mobile` and the `solus` URL scheme.

## Source and checks

- `src/solus/` connects T3 screens to the Solus session list, conversation, host discovery and settings.
- `solus-core/` contains the host client and shared conversation logic. The app reads the same RPC contracts as the other Solus clients.
- `modules/solus-lan-discovery/` contains the native LAN discovery module.
- Other workspace destinations show WIP where a Solus integration is pending.

Run the mobile checks from the Solus repository root.

```sh
cd -P apps/mobile
../../node_modules/.bin/vp test run --config vite.config.ts src/solus src/lib/threadActivity.test.ts app.config.test.ts src/features/connection/pairing.test.ts
```
