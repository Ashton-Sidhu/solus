# App windows and app shortcuts

Status: built 2026-11-26 in the desktop app for macOS, Windows, and Linux.
The shortcut link from the web client was added 2026-11-27. §6 says what each
client has. §7 says what is not built and what was not exercised on a real
machine.

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
  grants nothing. A launcher opens it.
- **shortcut link** — `solus://app-shortcut/<host>/<app id>`, with the
  optional parameters `address`, `account`, and `name` (§5). The web client
  makes it. The desktop app opens the app and asks the person to add its
  shortcut. It also grants nothing.

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
| What opens a `solus:` link from a browser | The `Info.plist`, and `setAsDefaultProtocolClient` at each start. | `setAsDefaultProtocolClient` at each start: `HKCU\Software\Classes\solus` runs Solus with the link. An update moves the program, so each start writes the key again. | At each start, `solus-link-handler.desktop` (hidden, `MimeType=x-scheme-handler/solus`, `Exec=<Solus> %u`) and `xdg-mime default` for the scheme. |
| Icon | `.icns` in the bundle | `.ico` in the desktop app's data folder | PNG in the desktop app's data folder |
| The window where open windows are listed | In the Dock under Solus: macOS has one Dock icon for each process. | Its own taskbar button with the shortcut's icon. A pin of it starts the app. | In Solus's group, with the shortcut's icon on the window. |

Rules for all three:

- **Solus changes only its own launcher.** The launchers folder is the
  person's. A launcher carries the app's identifier (the bundle identifier on
  macOS, the AppUserModelID on Windows, the id in the file name on Linux).
  Solus replaces or removes only a file with the identifier of the same app.
- **A name another file holds is not taken.** The launcher then gets a part of
  the app's id in its name.
- **A rename moves the launcher.** When an app opens and its launcher has
  another name, the desktop app writes the launcher again and removes the old
  one.
- **A development run keeps its launchers apart**, in `Solus Apps (Dev)` and
  as `solus-dev-app-<id>.desktop`. On macOS its launcher opens the development
  bundle, never the installed Solus. A development run does not register the
  `solus` scheme, so it never takes a link from the installed Solus.
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

A delete of the app removes its shortcut on this computer.

### Add app shortcut on the web client

On the web client the app menu has **Add app shortcut** for an app with a UI
whose host has an installation id. It opens a dialog:

- One sentence: in Solus for desktop, the app shows where the computer lists
  apps and opens in its own window.
- **Open in Solus**, the shortcut link. It has the focus when the dialog
  opens. Escape closes the dialog, and the focus goes back to the input bar.
- **Nothing opened? Download Solus**, the build for this computer's system,
  and the builds for the other two systems below it. The browser tells the
  system (`shortcutDeviceOf`).
- On a phone or a tablet (also an iPad that asks for desktop sites) only one
  sentence: app shortcuts are a feature of Solus for desktop. On a computer
  with another system: Solus for desktop runs on Mac, Windows, and Linux, and
  the downloads.
- When the page has no address of the host and no account that lists it, a
  note: the link works only when Solus on this computer already has the host.

The shortcut link carries what the page knows of the host:

- `address` — the `http:` or `https:` origin of the route that the page dials
  the host at. A `ws:` route gives its `http:` origin.
- `account` — the subject of the account the page is signed in to, only when
  that account lists the host (the host has a directory entry).
- `name` — the app's name. It only labels the window until the host answers.

The parser refuses the link when a part has another form: an unknown or a
repeated parameter, a fragment, an id of another shape, a longer path, an
`address` that is not a bare origin (a path, a user, a query, `file:`,
`javascript:`, a local path), a name with a control or a line character, or a
link longer than 2048 characters. The desktop app takes two links only: the
app link and the shortcut link. Each one opens an app, and nothing else.

### What the desktop app does with a shortcut link

1. A link from a browser, a launcher, or a second launch goes to
   `openAppLink` in the main process. Before the app is ready, a link waits. A link that already
   waits is dropped, and at most four wait.
2. The app window of the app opens (§2). When this computer has no shortcut
   for the app, the window carries the offer of the link. When the window is
   already open, it gets the offer and comes to the front.
3. When the app shows, the window asks: **Add an app shortcut for {name}?**,
   with the name that the host gives. **Add app shortcut** has the focus;
   **Not now** and Escape close the question. The link never adds the
   shortcut by itself: the person does.
4. When this computer does not know the host, the window says why and offers
   one next step and **Try again**, which reads the host list and the sign-in
   again:
   - Solus here is signed in to another account than the link's: **Open
     account settings**.
   - Solus here is signed out, and the link names an account: **Sign in…**,
     which opens the account settings in the workspace window.
   - The host is not on this computer's host list, and the link has an
     address: the window reads `/health` at the address with no credential.
     When the host answers with the installation id of the link, **Add
     host…** opens the Add host dialog of the workspace window at that
     address. When another host answers, the window says so and offers no
     add. When nothing answers, it says that this computer cannot reach the
     address.
   - With no address: **Add host…** opens the Add host dialog empty.

The address only names where to look. The Add host dialog still asks for the
pairing code of the host, as for an address that the person types.

## 6. What each client has

| Client | App window | App shortcut |
|---|---|---|
| Desktop (macOS, Windows, Linux) | Yes | Yes |
| Web | No | **Add app shortcut** gives the shortcut link to Solus for desktop on the same computer (§5) |
| Mobile | No | No |

This is a platform exception to "each UI change reaches every client". A
launcher is a file of a desktop operating system, and an app window is a
window of the desktop app: both are native shell behaviour. The web client
cannot write a launcher, so it hands the app to the desktop app with a link.
A phone browser shows the same dialog with one sentence in place of the link,
because there is no Solus for desktop on a phone (no phone layout).

Mobile (the native app in `apps/mobile/`) has no command. Decision of
2026-11-27: the mobile app has no app surface at all, so there is no menu to
put it in, and a shortcut is a file of a desktop computer. When the mobile app
gets an app surface, it shows no shortcut command; the reason is the same.

## 7. Not built, and not exercised

Not built:

- Native capabilities for an app in its window: a menu-bar item, global
  shortcuts, a badge, notifications of its own, camera, and microphone. The
  app frame has no origin, so each one must be a new name on
  `window.solusApp`, not a web API.
- A link from a notification to an app.
- The shortcut link does not sign in for the person or add the host itself:
  it opens the account settings or the Add host dialog, and the person
  finishes there and chooses **Try again**.
- The app window does not follow a sign-in or a new host while it is open:
  **Try again** reads them again.
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
entry, and the two Electron parts (the app window itself and the delivery of
an app link to Solus). The tests pin their rules with no operating system.
The shortcut link was not opened from a real browser on any system: the
registration of the scheme on Windows and Linux, the browser's question
before it opens Solus, the web dialog, the offer in the app window, and the
Add host and account steps were not run. The tests pin the link, its
parser, the queue of waiting links, the window's request, the host states,
the check of the address, and the Linux handler entry.
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
| **Install as app** on the web dashboard: a dialog with **Open in Executor**, **Nothing opened? Update Executor**, the download buttons, and one sentence on a phone or a tablet (also an iPad that asks for desktop sites). | Taken, as **Add app shortcut** (§5). "Download Solus" in place of "Update", because the person may not have Solus for desktop. Linux has a download too. |
| `executor://install?server=<origin>&app=…&org=…&name=…&team=…`, read strictly: an unknown or a repeated parameter, or an id of another shape, refuses it. `name` and `team` only label the prompt. | Taken, as the shortcut link. The host is in the path by installation id, as in the app link, because a Solus client names hosts by it. The `address` is optional: a page can reach its host only through the account. Solus has no team on a host, so `account` (the subject) takes the place of `org`, and only to tell "signed out" and "another account" from "not added". |
| `server` must be `https:`, or `http:` on a loopback address. | Not taken. Solus pairs hosts on a local network over `http:` and proves the host's identity key at the pairing. The address only fills the Add host dialog, which asks for the pairing code. |
| The desktop reads `/.well-known/executor` at `server` with no cookies before it acts. | Taken, as a read of `/health`: the window offers to add the host only when the address answers with the link's installation id. |
| One link at a time; a link that already waits is ignored, and at most four wait. | Taken for the links that wait for the app to be ready. After that, a link opens a window, and one app has one window. |
| A native **Install** dialog in the main process before the install. | Taken as a question in the app window, above the app frame, with the name that the host gives. The main process of Solus does not read hosts: the window does. The app frame is sandboxed and cannot press it. |
| Prompts to sign in, to sign in to another team, or to sign in again. | Taken as the states of the app window (§5): another account, signed out, not added. They open the account settings; the person signs in there. |
| The scheme is registered with `setAsDefaultProtocolClient` on macOS and Windows, in a packaged app only. | Taken. Linux too, with a hidden desktop entry, because Solus has launchers on Linux. |

## 9. Where the code is

- `packages/contracts/src/app-shortcuts.ts` — the app link and the address of
  an app window's page; `app-shortcut-links.ts` — the shortcut link, its
  parser, and the two links the desktop app takes (apart, so the first screen
  of the desktop renderer does not load them).
- `apps/desktop/src/main/app-shortcuts/` — the records, the app windows, the
  text of each launcher, the icon files, and the IPC.
- `apps/desktop/src/main/platform/*-app-launchers.ts` — one adapter for each
  operating system.
- `apps/desktop/src/renderer/shell/AppWindow.svelte` — the page of an app
  window; `app-window-host.ts` — the host states and the check of a link's
  address.
- `packages/workspace-ui/src/components/app/AppShortcutLinkDialog.svelte` and
  `lib/app-shortcut-link.ts` — the web client's dialog and its rules.
- `packages/workspace-ui/src/contexts/apps/app-shortcuts.store.svelte.ts` —
  the renderer's mirror of the shortcuts, and the commands.
- `tests/unit/app-shortcuts.test.ts`, `tests/unit/app-shortcuts-store.test.ts`,
  `tests/unit/app-shortcut-link.test.ts`.
