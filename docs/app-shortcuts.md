# App windows and app shortcuts

Status: built 2026-11-26 in the desktop app for macOS, Windows, and Linux.
2026-11-27: the app's own icon, the refresh of a launcher by its icon key,
the Trash for removed launchers, the shortcut link from the web client, and
the app window's menus and desktop capabilities. §6 says what each client
has. §7 says what is not built and what was not exercised on a real machine.

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

`app-shortcut-records.json` in the desktop app's own data folder holds the shortcuts
(the app, the name on the launcher, the path of the launcher, the icon key of
its icon, and the format of the launcher), the place of each app window, and
the person's answers for the desktop capabilities of each app (§5.1). No host keeps them, because a launcher is a file of
one computer.

The global shortcut that summons Solus keeps `app-shortcuts.json`, its own
file. An older Solus kept the records in that file too, and a save of one
feature deleted the other's data. At its first start, this Solus moves records
that it finds in `app-shortcuts.json` to `app-shortcut-records.json`, so the
person's shortcuts stay; a summon shortcut in that file stays where it is.

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
| Icon | `.icns` in the bundle | `.ico` in the desktop app's data folder, which the app's window takes too | PNG in the desktop app's data folder, which the app's window takes too |
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
- **A launcher follows its app.** When an app opens (in the app pane or in
  its app window) and it has a shortcut, the desktop app compares the name,
  the icon key, and the launcher format with the shortcut's record. When one
  differs, it writes the launcher and its icon again, and an open app window
  takes the new icon. A rename moves the launcher and deletes the old one; the old one does not go
  to the Trash, because the new one replaces it. An
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
  bundle, never the installed Solus. A development run does not register the
  `solus` scheme, so it never takes a link from the installed Solus.
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

While the main process writes or removes the launcher, the command reads
**Adding shortcut…**, **Removing shortcut…**, or **Updating shortcut…** (a
rename), and it cannot run again. Every surface reads that state from one
owner, `appShortcutsStore`, so two panes of one app show the same thing. A
running toast shows the change and turns into its result: where the launcher
is now (in the Trash, deleted, or still in its place). A failure says what went
wrong and offers **Try again**. Focus then goes back to the input bar.


A delete of the app removes its shortcut and its permissions on this
computer.

An app window has its own menu: the macOS menu bar while the window has focus,
the window's own menu bar on Windows and Linux. It has **Reload**,
**Permissions** (a check item for each capability), **Remove from menu bar**
when the app shows an item there, **Remove <App> shortcut…** when it has a
shortcut, **Close Window**, and **Quit <App>**. On macOS the Solus menu, Edit,
and Window stay around it; another Solus window gets the Solus menu back.

An app with a menu-bar item has a tray menu: **Open <App>**, **Reload**,
**Permissions**, **Remove from menu bar**, and **Quit <App>**.

Settings → General → **App permissions** lists each app with an answer on this
computer, and sets each permission to Ask, Allow, or Don't allow.

### 5.1 Desktop capabilities

An app in its app window can use native capabilities, each one behind a
permission that the person answers once (`docs/plans/app-desktop-capabilities.md`):

| Permission | What the app gets |
|---|---|
| Menu bar item (`menuBar`) | An item in the menu bar (macOS) or a tray icon, with a title of up to 24 characters. A close hides the window, and the page keeps running. |
| Keyboard shortcuts (`shortcuts`) | Up to 8 global shortcuts. Keys that another program holds fail with `ShortcutTaken`. |
| Keep above other windows (`floating`) | The window above other windows. |
| Start at login (`startAtLogin`) | The app opens with no window each time Solus starts, and Solus opens at login. |
| Microphone, Camera | `getUserMedia` in the app's page; the operating system asks too. |
| Read the clipboard (`clipboardRead`) | `desktop.clipboard.readText()`. |
| Notifications (`notifications`) | `desktop.notify`; a click brings the window to the front at a route. |

The badge (a count on the icon) and the window controls (show, hide, focus,
toggle, focus and blur events) need no permission.

A new app has no answers. The first call that needs one shows a native
**Allow** / **Don't Allow** dialog. After a refusal the call fails with
`DesktopPermissionDenied` and asks no more; only the person changes the
answer, in the app menu, the tray menu, or Settings. A revoke applies at once.
The answers are in `app-shortcut-records.json` (§3), by app.

App authors use `desktop` from `@solus/app`
(`resources/plugins/solus/skills/create-app/references/desktop.md`).

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

| Client | App window | App shortcut | Desktop capabilities | App permissions in Settings |
|---|---|---|---|---|
| Desktop (macOS, Windows, Linux) | Yes | Yes | Yes, in an app window | Yes |
| Desktop, an app in the workspace | — | — | No: `available: false` | — |
| Web | No | **Add app shortcut** gives the shortcut link to Solus for desktop on the same computer (§5) | No: `available: false` | No |
| Mobile | No | No | No: `available: false` | No |

The app's icon (§4) shows on desktop and web. The mobile app shows no app of
Solus yet (only the apps of MCP servers), so there is no place for it there;
`appIcon` is in the RPC contract for the day it does.

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

The desktop capabilities are the same exception. A menu-bar item, a global
shortcut, a login item, and a badge belong to a desktop operating system and
to a window of the desktop app. On web and mobile, and in the workspace of the
desktop app, the frame says `solusApp.desktop === false`: `desktop.available`
is false, `permission` resolves `unavailable`, and every other call fails with
`DesktopUnavailable`. An app checks `available` and works without them.

## 7. Not built, and not exercised

Not built:

- From the desktop capabilities: system audio, the menu-bar popover page (a
  small page of the app under its item), and a second window of an app
  (`desktop.window.open`). Each needs a second page of the app in its own
  window, and the app frame has one page.
- The web `Notification` and `navigator.clipboard.readText` APIs in an app's
  page: the frame has no origin, so the app uses `desktop.notify` and
  `desktop.clipboard.readText` instead.
- On macOS, Solus cannot tell a start by its own login item from one that the
  person set: the workspace window shows at login. Windows and Linux keep it
  hidden (`--solus-login`).
- A delete of an app from another client, or by an agent, leaves its
  permissions on this computer until it is deleted here.
- The shortcut link does not sign in for the person or add the host itself:
  it opens the account settings or the Add host dialog, and the person
  finishes there and chooses **Try again**.
- The app window does not follow a sign-in or a new host while it is open:
  **Try again** reads them again.
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
app link to Solus), the drawing of an `icon.svg` to the launcher's PNG in a
renderer (its source, the key, and the refresh are tested; the canvas is
not), and `shell.trashItem` itself (the tests use a Trash that moves the
file, and one that refuses it).
The tests pin their rules with no operating system.
The shortcut link was not opened from a real browser on any system: the
registration of the scheme on Windows and Linux, the browser's question
before it opens Solus, the web dialog, the offer in the app window, and the
Add host and account steps were not run. The tests pin the link, its
parser, the queue of waiting links, the window's request, the host states,
the check of the address, and the Linux handler entry.
None of the desktop capabilities was exercised on a real machine: the menus,
the tray item, the permission dialog, global shortcuts, keep on top, the
login item on each operating system, the badge, notifications, the
clipboard, and `getUserMedia` from the app frame (which needs the frame's
`allow="microphone *; camera *"` and the session's permission handler).
`tests/unit/app-desktop.test.ts` pins their rules with fakes for each
Electron part.
On macOS the launcher was made and checked with `plutil`, `iconutil`, and a
launch of a copy whose program only wrote a file.

## 8. What Executor does

| Executor | Solus |
|---|---|
| A launcher that opens `executor://app/<server>/<app>`; on macOS a compiled program in a generated bundle. | Taken, with a shell script as the program: Solus has no build step for a native one, and macOS runs a script the same way. |
| A window on the app's own origin, with the dashboard's session cookie. | Not needed. The window is a Solus client: it has the host connection of the desktop app. |
| A bridge of native capabilities with nine permissions, a native prompt, and grants kept by app. | Taken, with eight: no system audio (§7). The bridge is `@desktop/` calls on `window.solusApp`, because the app frame has no origin and no preload. |
| Notifications and clipboard through the web APIs, which its preload wraps. | `desktop.notify` and `desktop.clipboard.readText`: no preload reaches the frame. |
| A menu-bar item for an app with a `ui/menubar.html` popover. | An item for any app that sets a title, with a menu and no popover. |
| A menu of each app window, and a tray menu. | Taken. |
| No launcher on Linux. | A desktop entry. |
| Installed apps on this device only, keyed by server and app. | Taken (§3). |
| `ui/icon.svg`, at most 64 KiB, checked at deploy: one SVG root, no `script` or `foreignObject`, no `on*` attribute, `href` only to `#id`, no DOCTYPE or processing instruction. | Taken as `icon.svg` beside `app.ts`, since a Solus app has its UI in `src/`. Checked at the save too, so an agent learns at once. Solus also refuses `image`, HTML, an animation of a link, and a `url()` outside the icon, and requires a `viewBox` so the icon scales. |
| The icon served at a route of the app's origin, read by the desktop app over HTTP. | An RPC (`appIcon`) with the hash in the app's summary: a Solus client has no app origin, and the hash lets each client read an icon once. |
| The icon drawn in a hidden, sandboxed window at each size, with the monogram when it fails. | Drawn once at 1024 pixels in the renderer, which already reads the icon, and made into each size by the main process, as the tile was. |
| `refresh` on each open: an icon key (`svg:<hash>` or `monogram:<name>`) and `launcherOutdated` (a launcher whose program is an old script) write the launcher again. | Taken. The key of the tile has the letter and the hue, because a Solus tile has a colour the owner picks. The outdated check is a format number in the record, since all of Solus's launchers are text files that it writes. |
| The dashboard shows the icon in an `<img>`, with the next source on an error. | Taken: `AppTile` shows the icon and the monogram on an error. |
| An uninstall moves the macOS launcher to the Trash and deletes the Windows shortcut; a failure is a warning. | Taken for macOS, and Windows uses the Recycle Bin too. A launcher that the Trash refuses stays (Executor logs and goes on as well). Linux deletes (§4). |
| **Installing…** and **Uninstalling…** on the buttons, the failure text beside them, and **Check again** when the desktop's answer could not be read. | Taken (§5): the labels of the menu command and a toast with **Try again**; **Check again** in Settings. |
| App pages for **signed-out**, **gone** (with **Uninstall**), and **offline** (with **Retry**). | Taken as the states of §2: unavailable, no longer available (both with **Remove app shortcut**), and not connected (with **Try again**). |
| **Sign out** keeps installed apps; **Remove from this computer…** of an account uninstalls its apps, in one confirmed step. | Sign out is taken. A Solus host is not an account: removing it offers to remove its shortcuts after it is gone, and does not remove them unasked, because a host that is paired again opens them again. |
| **Install as app** on the web dashboard: a dialog with **Open in Executor**, **Nothing opened? Update Executor**, the download buttons, and one sentence on a phone or a tablet (also an iPad that asks for desktop sites). | Taken, as **Add app shortcut** (§5). "Download Solus" in place of "Update", because the person may not have Solus for desktop. Linux has a download too. |
| `executor://install?server=<origin>&app=…&org=…&name=…&team=…`, read strictly: an unknown or a repeated parameter, or an id of another shape, refuses it. `name` and `team` only label the prompt. | Taken, as the shortcut link. The host is in the path by installation id, as in the app link, because a Solus client names hosts by it. The `address` is optional: a page can reach its host only through the account. Solus has no team on a host, so `account` (the subject) takes the place of `org`, and only to tell "signed out" and "another account" from "not added". |
| `server` must be `https:`, or `http:` on a loopback address. | Not taken. Solus pairs hosts on a local network over `http:` and proves the host's identity key at the pairing. The address only fills the Add host dialog, which asks for the pairing code. |
| The desktop reads `/.well-known/executor` at `server` with no cookies before it acts. | Taken, as a read of `/health`: the window offers to add the host only when the address answers with the link's installation id. |
| One link at a time; a link that already waits is ignored, and at most four wait. | Taken for the links that wait for the app to be ready. After that, a link opens a window, and one app has one window. |
| A native **Install** dialog in the main process before the install. | Taken as a question in the app window, above the app frame, with the name that the host gives. The main process of Solus does not read hosts: the window does. The app frame is sandboxed and cannot press it. |
| Prompts to sign in, to sign in to another team, or to sign in again. | Taken as the states of the app window (§5): another account, signed out, not added. They open the account settings; the person signs in there. |
| The scheme is registered with `setAsDefaultProtocolClient` on macOS and Windows, in a packaged app only. | Taken. Linux too, with a hidden desktop entry, because Solus has launchers on Linux. |

## 9. Where the code is

- `packages/contracts/src/app-shortcuts.ts` — the app link, the address of
  an app window's page, and the icon key; `app-shortcut-links.ts` — the
  shortcut link, its parser, and the two links the desktop app takes (apart,
  so the first screen of the desktop renderer does not load them).
- `packages/contracts/src/apps.ts` — `APP_ICON_FILE`, `MAX_APP_ICON_BYTES`,
  `AppIcon`, and `AppSummary.iconHash`; `appIcon` in `rpc.ts`.
- `packages/server/src/apps/app-icon.ts` — the check of an icon;
  `app-project.ts` reads it into a build.
- `packages/workspace-ui/src/contexts/apps/app-icons.store.svelte.ts` — the
  icons a client keeps; `app-shortcut-icon.ts` draws the launcher's icon.
- `apps/desktop/src/main/app-shortcuts/` — the records, the app windows, the
  text of each launcher, the icon files, and the IPC; the desktop
  capabilities (`app-desktop.ts`, with their Electron parts in
  `app-desktop-electron.ts`) and the menus (`app-menus.ts`).
- `packages/contracts/src/app-desktop.ts` — the permissions, the calls, and
  the failures.
- `apps/desktop/src/main/platform/*-app-launchers.ts` — one adapter for each
  operating system.
- `apps/desktop/src/renderer/shell/AppWindow.svelte` — the page of an app
  window; `app-window-host.ts` — the host states and the check of a link's
  address.
- `packages/workspace-ui/src/components/app/AppShortcutLinkDialog.svelte` and
  `lib/app-shortcut-link.ts` — the web client's dialog and its rules.
- `packages/workspace-ui/src/contexts/apps/app-shortcuts.store.svelte.ts` —
  the renderer's mirror of the shortcuts, the change that runs on each, and
  the commands.
- `packages/workspace-ui/src/contexts/apps/app-shortcut-commands.ts` and
  `app-shortcut-messages.ts` — the commands with their toasts, the offer after
  a host removal, **Remove all**, and their text.
- `packages/workspace-ui/src/components/settings/AppPermissionsSection.svelte`
  and `contexts/apps/app-permissions.store.svelte.ts` — Settings → App
  permissions.
- `tests/unit/app-shortcuts.test.ts`, `tests/unit/app-shortcuts-store.test.ts`,
  `tests/unit/app-shortcut-ipc.test.ts`, `tests/unit/app-shortcut-commands.test.ts`,
  `tests/unit/app-shortcut-messages.test.ts`, `tests/unit/app-icons.test.ts`,
  `tests/unit/app-icons-store.test.ts`, `tests/unit/app-shortcut-link.test.ts`, `tests/unit/app-desktop.test.ts`,
  `tests/unit/app-desktop-bridge.test.ts`, `tests/unit/app-permissions-store.test.ts`.
