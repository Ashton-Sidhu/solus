# App windows and app shortcuts

Status: built 2026-11-26 in the desktop app for macOS, Windows, and Linux.
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
- It shows each state in the window: the host is not connected (with **Try
  again**), the app is stopped (with **Start**), the app has no version or no
  UI, and a read that failed (with **Try again**). A host that this computer
  does not know (it was removed here, or the person signed out of the account
  that listed it) shows **<App> is unavailable.** An app that its host does not
  have now shows **<App> is no longer available.** In those two states an app
  with a shortcut offers **Remove app shortcut**, never a blank window.
- It uses the person's theme, fonts, and zoom, and follows a change that the
  workspace window makes.
- It has the operating system's own title bar, with the app's name.
- The window opens where the person left it, when that place is on a display
  now.

One app has one window: a second open brings the first to the front.

The owner manages an app in the workspace. An app window has no Manage page.

## 3. What this device keeps

`app-shortcuts.json` in the desktop app's own data folder holds the shortcuts
(the app, the name on the launcher, and the path of the launcher) and the
place of each app window. No host keeps them, because a launcher is a file of
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
| Icon | `.icns` in the bundle | `.ico` in the desktop app's data folder | PNG in the desktop app's data folder |
| The window where open windows are listed | In the Dock under Solus: macOS has one Dock icon for each process. | Its own taskbar button with the shortcut's icon. A pin of it starts the app. | In Solus's group, with the shortcut's icon on the window. |

Rules for all three:

- **Solus changes only its own launcher.** The launchers folder is the
  person's. A launcher carries the app's identifier (the bundle identifier on
  macOS, the AppUserModelID on Windows, the id in the file name on Linux).
  Solus replaces or removes only a file directly in its launchers folder with
  the identifier of the same app.
- **A removed launcher goes to the Trash.** On macOS it goes to the Trash and
  on Windows to the Recycle Bin (`shell.trashItem`), so the person can take it
  back. A launcher that was taken back opens its app again (the link needs no
  record), and **Add app shortcut** then takes the same file back and makes no
  second one. On Windows the shortcut's icon file is deleted with the record, so
  a restored shortcut shows a plain icon until it is added again.
- **A Trash that refuses the launcher does not stop the removal.** The record
  goes, the main process logs `app_launcher_trash_failed`, and the launcher
  stays where it is: Solus does not delete it for good without asking (the
  rule of `moveToTrash` for files). The message names the path, so the person
  can delete it.
- **Linux deletes its desktop entry.** The Trash of a Linux desktop needs a
  program of its own (`gio`), which many desktops do not have, so it is not a
  dependable place. The entry is a text file that Solus names and writes, in a
  folder that the person does not browse, and its icon is a file of Solus that
  goes with it: a restored entry would have no icon. **Add app shortcut** writes
  the same entry again.
- **A name another file holds is not taken.** The launcher then gets a part of
  the app's id in its name.
- **A rename moves the launcher.** When an app opens and its launcher has
  another name, the desktop app writes the launcher again and deletes the old
  one. The old one does not go to the Trash: the new one replaces it.
- **A development run keeps its launchers apart**, in `Solus Apps (Dev)` and
  as `solus-dev-app-<id>.desktop`. On macOS its launcher opens the development
  bundle, never the installed Solus.
- **An AppImage** starts from its image file (`APPIMAGE`), because its mount is
  gone after it quits. The image's own start script adds `--no-sandbox` where
  the computer needs it, so the launcher does not.

The icon is the app's tile: its first letter on its hue. The renderer draws it
once, and the main process makes each size.

A launch from a launcher opens the app and keeps the workspace window hidden,
as after the person closes it. The Dock icon, the tray icon, or a normal
launch of Solus shows the workspace.

## 5. Commands

The app menu of the app surface has, for an app with a UI on the desktop app:

- **Open in its own window**
- **Add app shortcut**, or **Remove app shortcut** when the app has one.

While the main process writes or removes the launcher, the command reads
**Adding shortcut…**, **Removing shortcut…**, or **Updating shortcut…** (a
rename), and it cannot run again. Every surface reads that state from one
owner, `appShortcutsStore`, so two panes of one app show the same thing. A
running toast shows the change and turns into its result: where the launcher
is now (in the Trash, deleted, or still in its place). A failure says what went
wrong and offers **Try again**. Focus then goes back to the input bar.

A delete of the app removes its shortcut on this computer.

Account and host actions:

- **Sign out** of the Solus account keeps the app shortcuts. A shortcut of an
  app on a host that only the account listed then shows the app as unavailable
  (§2) until the person signs in again.
- **Removing a host** from this client (Settings, the Fleet view, or deleting a
  cloud host) offers, in a toast, to remove the shortcuts of that host's apps:
  **<Host> has 2 app shortcuts on this computer.** with **Remove shortcuts**.
  It does not remove them unasked: a host that is paired again has the same
  installation id, and its launchers then open again. A shortcut that stays
  shows the app as unavailable.
- **Settings → General → Applications → App shortcuts** (desktop only) shows
  how many apps have a shortcut on this computer, and **Remove all…** asks with
  the count (**Remove all 3 app shortcuts from this computer?**) before it acts.
  A list that the desktop app could not read shows why, with **Check again**,
  not a count of zero. One shortcut that fails does not stop the others; the
  result names the failures and offers **Try again** for them.

## 6. What each client has

| Client | App window | App shortcut |
|---|---|---|
| Desktop (macOS, Windows, Linux) | Yes | Yes |
| Web | No | No |
| Mobile | No | No |

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
- The launcher follows a rename but not a new colour: the icon changes when
  the shortcut is added again.
- A launcher on Windows and Linux names the program of Solus at the time it
  was written. After that program moves (an AppImage in another folder), the
  person adds the shortcut again.
- A separate, smaller page for the app window. It loads the same page file as
  the workspace window, which preloads the workspace's code files. The app
  window does not run them.

Not exercised on a real machine: the Windows shortcut, the Linux desktop
entry, the two Electron parts (the app window itself and the delivery of an app
link to Solus), and `shell.trashItem` itself (the tests use a Trash that moves
the file, and one that refuses it). The tests pin their rules with no
operating system.
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
| An uninstall moves the macOS launcher to the Trash and deletes the Windows shortcut; a failure is a warning. | Taken for macOS, and Windows uses the Recycle Bin too. A launcher that the Trash refuses stays (Executor logs and goes on as well). Linux deletes (§4). |
| **Installing…** and **Uninstalling…** on the buttons, the failure text beside them, and **Check again** when the desktop's answer could not be read. | Taken (§5): the labels of the menu command and a toast with **Try again**; **Check again** in Settings. |
| App pages for **signed-out**, **gone** (with **Uninstall**), and **offline** (with **Retry**). | Taken as the states of §2: unavailable, no longer available (both with **Remove app shortcut**), and not connected (with **Try again**). |
| **Sign out** keeps installed apps; **Remove from this computer…** of an account uninstalls its apps, in one confirmed step. | Sign out is taken. A Solus host is not an account: removing it offers to remove its shortcuts after it is gone, and does not remove them unasked, because a host that is paired again opens them again. |

## 9. Where the code is

- `packages/contracts/src/app-shortcuts.ts` — the app link and the address of
  an app window's page.
- `apps/desktop/src/main/app-shortcuts/` — the records, the app windows, the
  text of each launcher, the icon files, and the IPC.
- `apps/desktop/src/main/platform/*-app-launchers.ts` — one adapter for each
  operating system.
- `apps/desktop/src/renderer/shell/AppWindow.svelte` — the page of an app
  window.
- `packages/workspace-ui/src/contexts/apps/app-shortcuts.store.svelte.ts` —
  the renderer's mirror of the shortcuts, the change that runs on each, and
  the commands.
- `packages/workspace-ui/src/contexts/apps/app-shortcut-commands.ts` and
  `app-shortcut-messages.ts` — the commands with their toasts, the offer after
  a host removal, **Remove all**, and their text.
- `tests/unit/app-shortcuts.test.ts`, `tests/unit/app-shortcuts-store.test.ts`,
  `tests/unit/app-shortcut-ipc.test.ts`, `tests/unit/app-shortcut-commands.test.ts`,
  `tests/unit/app-shortcut-messages.test.ts`.
