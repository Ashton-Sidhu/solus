# Desktop updates

How the desktop app finds, downloads, and installs a newer release, and how the
user sees and controls that. This locks the vocabulary and the rules; the code is
under `apps/desktop/src/main/updates/`, `apps/desktop/src/renderer/shell/`, and
`packages/workspace-ui/src/contexts/updates/`.

## Vocabulary

- **release** — one published desktop version: its version string, release notes,
  and release date.
- **update** — a release newer than the app that is running.
- **check** — asking the release feed whether an update exists.
- **update state** — where the app is in the life of one update. One of:
  **idle**, **checking**, **up-to-date**, **available**, **downloading**,
  **ready**, **error**.
- **update status** — the update state plus the running version and the
  auto-download setting. This is the whole object the main process owns and the
  renderer mirrors.
- **auto-download** — the setting that lets the app download an update as soon
  as a check finds one. On by default.
- **restart to update** — quit the app and install the downloaded update.
- **restart prompt** — the toast that offers *Restart* and *Later* once an
  update is ready.

## Ownership

The Electron main process owns the update status. It runs the checks, holds the
auto-download setting in `updates.json` under `userData`, drives
`electron-updater`, and broadcasts every status change to every window over the
native bridge. The renderer never talks to the feed.

The renderer mirrors the status in one store, `updatesStore`. Surfaces read the
store and call its commands; the store carries no UI of its own. The desktop
shell owns the toasts.

Updates are a desktop capability. On web and mobile the store reports
`isAvailable === false` and the update rows do not render. Those clients keep the
existing version-skew notice for host mismatches. This is an explicit platform
exception: a browser cannot replace the binary that serves it.

## State machine

```text
idle ──check──▶ checking ──none──▶ up-to-date
                   │
                   └──found──▶ available ──download──▶ downloading ──done──▶ ready
                                   │                       │
                                   └───────────error◀──────┘
```

- A check moves any state to **checking**. A check that finds nothing moves to
  **up-to-date** and records when. A check that finds an update moves to
  **available** with the release.
- With auto-download on, **available** moves to **downloading** at once. With it
  off, the user downloads from a toast action, Settings, or the palette.
- **downloading** carries a percent. **ready** carries the release.
- **error** carries a message and keeps the release when there was one, so
  Settings can offer *Try again* with the version still visible.
- **ready** is sticky. Later checks do not leave it; the update is on disk and
  the only way forward is a restart.

The main process checks ten seconds after boot and every four hours after that.
It never runs in a development build.

## The restart is the user's decision

The app never restarts itself. Downloading is silent because it changes nothing
the user can see. Installing replaces the running app, so it waits for a click.

The restart prompt never interrupts a turn. When the status becomes **ready**,
the shell shows the prompt only when no session on the local host is busy.
Otherwise it holds the prompt and shows it when the last busy session goes
idle. *Later* dismisses the prompt for this run; the gear dot and Settings keep
showing the ready state.

A restart the user starts from Settings, the palette, or the tray runs at once,
even while a session is busy. That is an explicit action on a visible control,
not a prompt.

## Surfaces

Every surface reads the same store, so Editor mode and Pill mode never disagree.

- **Toasts** (desktop shell, Editor mode only). *Available* with auto-download
  off: "Solus X is available" with *Download* and *Later*. Update toasts do not
  open Settings. *Ready*: the
  restart prompt, "Solus X is ready" with *Restart* and *Later*, persistent until
  answered. A check the user started reports its result: "up to date" as a
  success toast, a failure as an error toast. A background check that finds
  nothing or fails is silent; its state still shows in Settings. Pill mode shows
  no toast; it is a summon-and-go surface.
- **Gear dot.** The settings gear in the tab strip shows a small accent dot while
  an update is ready. It is the way to see the current state after a toast is
  gone.
- **Settings → General → About Solus.** The running version, a status line for
  the current state, and the commands for it: *Check for updates*, *Download*,
  *Restart to update*, or *Try again*. A switch for auto-download. Release notes
  render below the status as markdown when a release is known. This section is
  the way in and the way out for every state. Web and mobile show only the
  version row.
- **Command palette.** *Check for updates* whenever updates are available on this
  client. *Restart to update* only in the **ready** state. Both are in the
  keybinding manifest with no default combo, so a user can bind one.
- **Tray.** *Restart to update Solus X* appears above *Quit* only in the
  **ready** state.

## Release notes

Release notes travel inside the update feed manifest that `electron-builder`
writes (`latest-mac.yml`). The release workflow asks GitHub to generate the notes
for the tag before the build and writes them to `build/release-notes.md`, which
`electron-builder` folds into the manifest. The app renders that markdown; it
never fetches notes from the network on its own. `CHANGELOG.md` is not a source.

## Contract

`packages/contracts/src/desktop-update-types.ts` declares `DesktopUpdateRelease`,
`DesktopUpdateState`, and `DesktopUpdateStatus`. The native bridge gains:

- `updateStatus()` — the current status.
- `checkForUpdate()`, `downloadUpdate()`, `restartToUpdate()` — commands.
- `setUpdateAutoDownload(enabled)` — the setting.
- `onUpdateStatusChange(callback)` — every change, to every window.

These join `NativeSolusAPI`, the preload, and the native-only method allowlist
together.

## Tests

- `tests/unit/desktop-update-status.test.ts` — the reducer: every transition
  above, and that **ready** is sticky.
- `tests/unit/desktop-updates-store.test.ts` — the restart prompt waits for busy
  sessions and fires once when they go idle.
- `tests/unit/desktop-updater-load.test.ts` — `electron-updater` is loaded with
  `require`, not `import()`.

## Direct Settings action

The Settings header and Pill Settings menu expose the update action without
opening General or a host subpage. The shared button checks for updates, downloads
Solus, or restarts to install, according to the current desktop state. It shows
check/download progress and stays on the current page. Web and mobile use the
same header control to check connected hosts; remote server installation remains
manual. General retains version details, release notes, and automatic downloads.
