# Solus mobile

The Solus app for iOS and Android uses the T3 Code interface. `apps/mobile` contains the Expo app, its pnpm workspace, and its native dependencies.

## Run locally

From the Solus repository root, install both workspaces. The native workspace uses the versions of React Native and the native patches in its own pnpm lockfile.

```sh
bun install
bun run mobile:install
cd apps/mobile
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
bun run --cwd apps/mobile test:logic
```
