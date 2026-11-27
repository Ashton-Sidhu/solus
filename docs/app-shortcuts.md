# App windows and app shortcuts

Status: built 2026-11-26 in the desktop app for macOS, Windows, and Linux. The
app's own icon and the refresh of a launcher by its icon key: 2026-11-27.
§6 says what each client has. §7 says what is not built and what was not
exercised on a real machine.

The reference is Executor (`UsefulSoftwareCo/executor`, read at `c5693792` on
2026-11-25), which installs an app with a UI as a desktop app. §8 says what
Solus takes from it and what it does not.

## 1. Vocabulary

- **app window** — a desktop window that shows one app and no workspace.
- **app shortcut** — what makes an app show where the operating system lists
  apps on this computer. A person adds it and removes it.
- **launcher** — the file of an app shortcut: a small app bundle on macOS, a
  Start menu shortcut on Windows, a desktop entry on Linux.
- **app link** — `solus://app/<host>/<app id>`. `<host>` is the installation id
  of the app's host, as a sidebar pin names it. The link names an app and
  grants nothing.

Solus does not say "install" for this. The apps plan keeps that word for a
copy of an app on another host.

## 2. The app window

An app window is a second window of the desktop app. It loads the Solus
renderer page with the app in its address, and the page then mounts one
component (`apps/desktop/src/renderer/shell/AppWindow.svelte`), not the
workspace.

- It reads the app as the app surface does: through `appsStore`, with the app
  frame (`SandboxFrame`) and the same bridge (`window.solusApp`). An app needs
  no change to run in an app window.
- It dials only the host of its app. This computer's own host is known at
  once. Another host is known when the person's host list names it.
- It has no state of its own on a host. A new version, a stop, a rename, and
  a delete of the app reach it through the same events as the workspace.
- It shows each state in the window: the host is not connected, the host is
  not known on this computer, the app is stopped (with **Start**), the app has
  no version or no UI, and a read that failed (with **Try again**). When the
  app is gone from its host and has a shortcut, the window offers **Remove app
  shortcut**.
- It uses the person's theme, fonts, and zoom, and follows a change that the
  workspace window makes.
- It has the operating system's own title bar, with the app's name.
- The window opens where the person left it, when that place is on a display
  now.

One app has one window: a second open brings the first to the front.

The owner manages an app in the workspace. An app window has no Manage page.

## 3. What this device keeps

`app-shortcuts.json` in the desktop app's own data folder holds the shortcuts
(the app, the name on the launcher, the path of the launcher, the icon key of
its icon, and the format of the launcher) and the place of each app window. No host keeps them, because a launcher is a file of
one computer.

A launcher opens its app with no record: the app link is enough. A file that
cannot be read thus starts empty, and adding a shortcut again takes the same
launcher back.

## 4. The launcher on each operating system

| | macOS | Windows | Linux |
|---|---|---|---|
| Where | `~/Applications/Solus Apps/<Name>.app` | Start menu, `Solus Apps\<Name>.lnk` | `$XDG_DATA_HOME/applications/solus-app-<id>.desktop` |
| What it runs | `open -b <bundle id of Solus> <app link>` | Solus, with the app link as an argument | Solus, with the app link as an argument |
| How Solus gets the link | The `open-url` event. Solus names the `solus` scheme in its `Info.plist`. | The arguments of the launch, or of the second launch when Solus runs. | As Windows. |
| Icon | `.icns` in the bundle | `.ico` in the desktop app's data folder, which the app's window takes too | PNG in the desktop app's data folder, which the app's window takes too |
| The window where open windows are listed | In the Dock under Solus: macOS has one Dock icon for each process. | Its own taskbar button with the shortcut's icon. A pin of it starts the app. | In Solus's group, with the shortcut's icon on the window. |

Rules for all three:

- **Solus changes only its own launcher.** The launchers folder is the
  person's. A launcher carries the app's identifier (the bundle identifier on
  macOS, the AppUserModelID on Windows, the id in the file name on Linux).
  Solus replaces or removes only a file with the identifier of the same app.
- **A name another file holds is not taken.** The launcher then gets a part of
  the app's id in its name.
- **A launcher follows its app.** When an app opens (in the app pane or in
  its app window) and it has a shortcut, the desktop app compares the name,
  the icon key, and the launcher format with the shortcut's record. When one
  differs, it writes the launcher and its icon again, and an open app window
  takes the new icon. A rename moves the launcher and removes the old one. An
  app that did not change writes nothing.
- **The icon key** names what the icon was drawn from: `svg:<hash>` for the
  app's own icon, `monogram:<letter>:<hue>` for its tile. A new `icon.svg`, a
  new colour, and a new first letter each give another key. An icon that
  could not be read gives the tile's key, so the next open tries again.
- **The launcher format** (`LAUNCHER_FORMAT` in
  `app-shortcut-records.ts`) is a number in each record. A change to what a
  launcher holds (its `Info.plist`, its program, its desktop entry) raises
  it, and each launcher of an older format is written again when its app
  opens. A record from before the icon key has no key, so its launcher is
  written again once.
- **A development run keeps its launchers apart**, in `Solus Apps (Dev)` and
  as `solus-dev-app-<id>.desktop`. On macOS its launcher opens the development
  bundle, never the installed Solus.
- **An AppImage** starts from its image file (`APPIMAGE`), because its mount is
  gone after it quits. The image's own start script adds `--no-sandbox` where
  the computer needs it, so the launcher does not.

The icon is the app's own icon (below) when it has one, else its tile: its
first letter on its hue. The renderer draws it once at 1024 pixels, and the
main process makes each size that the launchers need (16 to 1024).

### The app's icon

An app can ship `icon.svg` beside `app.ts` (`APP_ICON_FILE`). The create-app
skill tells agents how to draw one (`references/design.md`).

- **The host checks it** at each save and at each build (deploy and preview),
  and refuses the save or fails the version with a reason an agent can act
  on (`packages/server/src/apps/app-icon.ts`). An icon is one `<svg>` root in
  the SVG namespace with a `viewBox`, UTF-8, at most 64 KiB. It has no
  script, no event attribute, no `foreignObject`, `image`, or HTML element,
  no DOCTYPE or entity, no processing instruction, no animation of a link,
  and no `href` or `url()` that names anything but an element of the icon.
- **A version keeps it.** The build commit holds `icon.svg`, and the version
  record holds its SHA-256. `AppSummary.iconHash` is the hash of the active
  version's icon, or null. A rollback brings back the icon of that version.
- **A client reads it once for each hash** with `appIcon`, which answers
  `{ hash, svg }`, never a path on the host. So a remote client gets it as a
  local one does, and a list of apps reads no icon until one changes.
  `appIconsStore` keeps each icon and gives it as a `data:` image address.
- **The monogram is the fallback.** An app with no icon, an icon that is on
  its way, a read that failed, and an image that did not load all show the
  tile. While a new icon loads, the old one stays.
- **Where it shows** on desktop and web: the sidebar's places, the header of
  the app pane, its tab in the surface strip, the cards of the Apps tab, the
  Overview of the Manage page (where the colour picker is replaced by a line
  that says the tile is the icon), the command palette's app rows (with the
  apps glyph as the fallback there), the launcher, and the window of an app
  on Windows and Linux. An `<img>` of an SVG runs no script and loads nothing
  outside it. Solus shows the icon as the author drew it, in light and dark
  mode, so the skill asks for a full tile with its own background.

A launch from a launcher opens the app and keeps the workspace window hidden,
as after the person closes it. The Dock icon, the tray icon, or a normal
launch of Solus shows the workspace.

## 5. Commands

The app menu of the app surface has, for an app with a UI on the desktop app:

- **Open in its own window**
- **Add app shortcut**, or **Remove app shortcut** when the app has one.

A delete of the app removes its shortcut on this computer.

## 6. What each client has

| Client | App window | App shortcut |
|---|---|---|
| Desktop (macOS, Windows, Linux) | Yes | Yes |
| Web | No | No |
| Mobile | No | No |

The app's icon (§4) shows on desktop and web. The mobile app shows no app of
Solus yet (only the apps of MCP servers), so there is no place for it there;
`appIcon` is in the RPC contract for the day it does.

This is a platform exception to "each UI change reaches every client". A
launcher is a file of a desktop operating system, and an app window is a
window of the desktop app: both are native shell behaviour. On web and mobile
the commands do not show. An app there opens in Solus as before.

## 7. Not built, and not exercised

Not built:

- Native capabilities for an app in its window: a menu-bar item, global
  shortcuts, a badge, notifications of its own, camera, and microphone. The
  app frame has no origin, so each one must be a new name on
  `window.solusApp`, not a web API.
- A link from another place (a browser, a notification) to an app. The
  `solus` scheme is named only on macOS, where the launcher needs it.
- A shortcut for a published deployment. It has an address that a browser
  opens.
- A launcher follows a new name and a new icon only when its app opens on
  this computer. A deploy with a new icon does not reach a launcher whose
  app nobody opens.
- An app window with no shortcut has the icon of Solus: the window's icon is
  the shortcut's icon file.
- A published deployment of an app does not get its icon.
- A launcher on Windows and Linux names the program of Solus at the time it
  was written. After that program moves (an AppImage in another folder), the
  person adds the shortcut again.
- A separate, smaller page for the app window. It loads the same page file as
  the workspace window, which preloads the workspace's code files. The app
  window does not run them.

Not exercised on a real machine: the Windows shortcut, the Linux desktop
entry, the two Electron parts (the app window itself and the delivery of an
app link to Solus), and the drawing of an `icon.svg` to the launcher's PNG in
a renderer (its source, the key, and the refresh are tested; the canvas is
not). The tests pin their rules with no operating system.
On macOS the launcher was made and checked with `plutil`, `iconutil`, and a
launch of a copy whose program only wrote a file.

## 8. What Executor does

| Executor | Solus |
|---|---|
| A launcher that opens `executor://app/<server>/<app>`; on macOS a compiled program in a generated bundle. | Taken, with a shell script as the program: Solus has no build step for a native one, and macOS runs a script the same way. |
| A window on the app's own origin, with the dashboard's session cookie. | Not needed. The window is a Solus client: it has the host connection of the desktop app. |
| A bridge of native capabilities with nine permissions. | Not taken (§7). |
| No launcher on Linux. | A desktop entry. |
| Installed apps on this device only, keyed by server and app. | Taken (§3). |
| `ui/icon.svg`, at most 64 KiB, checked at deploy: one SVG root, no `script` or `foreignObject`, no `on*` attribute, `href` only to `#id`, no DOCTYPE or processing instruction. | Taken as `icon.svg` beside `app.ts`, since a Solus app has its UI in `src/`. Checked at the save too, so an agent learns at once. Solus also refuses `image`, HTML, an animation of a link, and a `url()` outside the icon, and requires a `viewBox` so the icon scales. |
| The icon served at a route of the app's origin, read by the desktop app over HTTP. | An RPC (`appIcon`) with the hash in the app's summary: a Solus client has no app origin, and the hash lets each client read an icon once. |
| The icon drawn in a hidden, sandboxed window at each size, with the monogram when it fails. | Drawn once at 1024 pixels in the renderer, which already reads the icon, and made into each size by the main process, as the tile was. |
| `refresh` on each open: an icon key (`svg:<hash>` or `monogram:<name>`) and `launcherOutdated` (a launcher whose program is an old script) write the launcher again. | Taken. The key of the tile has the letter and the hue, because a Solus tile has a colour the owner picks. The outdated check is a format number in the record, since all of Solus's launchers are text files that it writes. |
| The dashboard shows the icon in an `<img>`, with the next source on an error. | Taken: `AppTile` shows the icon and the monogram on an error. |

## 9. Where the code is

- `packages/contracts/src/app-shortcuts.ts` — the app link, the address of
  an app window's page, and the icon key.
- `packages/contracts/src/apps.ts` — `APP_ICON_FILE`, `MAX_APP_ICON_BYTES`,
  `AppIcon`, and `AppSummary.iconHash`; `appIcon` in `rpc.ts`.
- `packages/server/src/apps/app-icon.ts` — the check of an icon;
  `app-project.ts` reads it into a build.
- `packages/workspace-ui/src/contexts/apps/app-icons.store.svelte.ts` — the
  icons a client keeps; `app-shortcut-icon.ts` draws the launcher's icon.
- `apps/desktop/src/main/app-shortcuts/` — the records, the app windows, the
  text of each launcher, the icon files, and the IPC.
- `apps/desktop/src/main/platform/*-app-launchers.ts` — one adapter for each
  operating system.
- `apps/desktop/src/renderer/shell/AppWindow.svelte` — the page of an app
  window.
- `packages/workspace-ui/src/contexts/apps/app-shortcuts.store.svelte.ts` —
  the renderer's mirror of the shortcuts, and the commands.
- `tests/unit/app-shortcuts.test.ts`, `tests/unit/app-shortcuts-store.test.ts`,
  `tests/unit/app-icons.test.ts`, `tests/unit/app-icons-store.test.ts`.
