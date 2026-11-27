# Desktop capabilities of an app window

Status: built 2026-11-27 in the desktop app; not exercised on a real machine (`docs/app-shortcuts.md` §7). Builds on `docs/app-shortcuts.md` (app windows and
app shortcuts). The reference is Executor (`UsefulSoftwareCo/executor`, branch
`v2`, `apps/docs/content/desktop-apps.mdx`).

## 1. Vocabulary

- **desktop capability** — a native ability that an app has in its app window:
  a menu-bar item with its menu-bar page, a global shortcut, keep on top,
  start at login, the microphone, the camera, system audio, a read of the
  clipboard, a notification, a badge, and the controls of its own window.
- **permission** — a desktop capability that needs the person's answer before
  the app uses it. There are nine: `menuBar`, `shortcuts`, `floating`,
  `startAtLogin`, `microphone`, `camera`, `systemAudio`, `clipboardRead`,
  `notifications`.
- **menu-bar page** — an optional second page of an app (`menubar.html`
  beside `index.html`), shown in the **popover**: a small frameless window
  under the app's menu-bar item.
  The badge and the window controls need no permission.
- **grant** — the person's answer for one permission of one app on this
  device: `granted` or `denied`.
- **permission state** — what an app reads: `granted`, `denied`, `prompt`
  (no answer yet), or `unavailable` (not in a desktop app window, or not on
  this operating system).
- **app menu** — the menu of one app window: the macOS menu bar while the
  window has focus, the window's own menu bar on Windows and Linux.
- **tray menu** — the menu of an app's menu-bar item.

## 2. The permission model

1. A new app has no grants. Each permission is `prompt`.
2. A call that needs a permission in `prompt` shows a native dialog with
   **Allow** and **Don't Allow**. The answer is the grant. One dialog shows at
   a time.
3. A call that needs a permission in `denied` fails with
   `DesktopPermissionDenied` and shows no dialog. Only the person changes a
   grant again: in the app menu (**Permissions**), the tray menu, or Settings
   → General → **App permissions**.
4. A change from Settings or a menu applies at once: a revoke of `menuBar`
   removes the item, of `shortcuts` releases each shortcut, of `floating`
   puts the window down, of `startAtLogin` turns the login item off when no
   other app needs it.
5. The grants are on this device: `app-shortcut-records.json` keeps them beside the
   shortcuts, by app. No host keeps them. A delete of the app removes them.
6. The main process names the app of a call from the window that sent it,
   never from the call. The app's page has no origin and cannot reach the
   preload; only the Solus page of its window relays its calls.

## 3. The contract

The app's page calls `window.solusApp.call("@desktop/<operation>", args)`. The
Solus page of the app window answers it through the preload
(`solus:app-desktop-call`). The main process reads the call into one typed
union (`appDesktopCallSchema`) at the IPC edge, and answers with a result,
never a thrown error, so a typed failure crosses IPC:

| Operation | Arguments | Answer | Permission |
|---|---|---|---|
| `permission` | `{ name }` | state | — |
| `request-permission` | `{ name }` | state | asks once |
| `menu-bar-title` | `{ text: string \| null }` (24 characters) | null | `menuBar` |
| `shortcut-register` | `{ accelerator }` | `{ id }` | `shortcuts` (8 an app) |
| `shortcut-unregister` | `{ id }` | null | — |
| `floating` | `{ on }` | null | `floating` |
| `window` | `{ action: show \| hide \| focus \| toggle }` | null | — |
| `badge` | `{ count: 0–99999 \| null }` | null | — |
| `notify` | `{ title, body?, route? }` | null | `notifications` |
| `clipboard-read` | `{}` | text | `clipboardRead` |
| `system-audio` | `{}` | null; then the page's `getDisplayMedia` gets the audio | `systemAudio` |

Failures: `DesktopUnavailable`, `DesktopPermissionDenied { permission }`,
`ShortcutTaken { accelerator }`, `DesktopInvalidInput { message }`,
`SystemAudioBlocked` (macOS has not allowed Solus to record system audio). The frame
gives the page an `Error` whose `name` is the code; `@solus/app` makes each one
its own class.

The page learns of events through `solusApp.on(listener)`: `desktop-shortcut
{ id }`, `desktop-window { type: focus | blur }`. A click on a notification
with a `route` (`#/reports/42`) brings the window to the front and sets
`location.hash` in the page (the frame's bridge does this).

The microphone and the camera are `navigator.mediaDevices.getUserMedia`: the
frame of an app window allows them, and the main process's permission handler
asks for the grant, then for the operating system's access.

System audio is `getDisplayMedia` too. `@desktop/system-audio` asks for the
grant and, on macOS, checks Screen & System Audio Recording. The session's
display-media handler then gives only an app's frame (in its app window or
popover) with the grant its own frame as the video and `audio: 'loopback'`;
`@solus/app` drops the video track. Every other page gets nothing from that
handler.

The menu-bar page: the main page's `AppUi.menuBarPage` gives its size or
null. The app window's Solus page sends it to the main process
(`solus:app-menu-bar-page`), and the app's icon as a PNG
(`solus:app-window-icon`), never from a popover. The popover loads the Solus
page with `app-window-page=menubar`, which reads `appUi({ page: 'menubar' })`.

`window.solusApp.desktop` is `true` only in a desktop app window.
`@solus/app` exports `desktop` (with `available`) and the React hooks
`useDesktopShortcut`, `useDesktopWindowEvent`, `useDesktopBadge`,
`useDesktopPermission`, and `useSystemAudio`. Outside an app window `available` is false,
`permission` and `requestPermission` resolve `unavailable`, every other call
rejects with `DesktopUnavailable`, and an event listener does nothing.

## 4. Lifecycle

- An app's window that has a menu-bar item hides on close; the page keeps
  running, so its title and shortcuts stay. **Quit <App>** closes it.
- A window that closes with no menu-bar item ends the app: its shortcuts, its
  badge, and its floating state go.
- A reload of the window releases the page's shortcuts and its menu-bar
  title. A new page that registers an accelerator that its app holds takes it.
- At each start, the desktop app opens each app with `startAtLogin` granted,
  with no window shown. The login item opens Solus at login. Solus turns the
  login item on for the first such app and off after the last, and never
  turns off a login item that it did not turn on. On macOS a login item that
  the person made stays theirs: Solus does not take it.
- A start by Solus's own login item keeps the workspace window hidden on
  each system: Windows and Linux see `--solus-login`; macOS sees
  `wasOpenedAtLogin` while Solus turned the item on for the apps.
- An app with a menu-bar page asks for `menuBar` when its window opens. Its
  popover hides on blur, and closes with the window, a revoke of the item,
  and a version with no such page.
- A delete of the app on its host, from any client, clears its grants, its
  shortcut, and its window place on this desktop (`docs/app-shortcuts.md`
  §3).
- A first **Don't Allow** for a device changes nothing in the page. A revoke
  of a device grant reloads the window, so a capture stops.

## 5. The menus

App menu: **Reload**, **Permissions** (a check item for each permission),
**Remove from menu bar** when it has an item, **Remove <App> shortcut…** when
it has a shortcut, **Close Window**, **Quit <App>**. On macOS it is after the
Solus menu and before Edit and Window; the workspace window gets back the
menu it had.

Tray menu: **Open <App>**, **Reload**, **Permissions**, **Remove from menu
bar**, **Quit <App>**. On Windows and Linux the app's title is its first
line; on Linux an app with a menu-bar page has **Show <App> Popover** first.
A click on the item opens the popover (else, on Windows, the app); on macOS
an app with a popover shows the menu on a right click.

## 6. What each operating system supports

Decision of 2026-11-27: the capabilities are at parity on macOS, Windows, and
Linux. Where a system cannot do a part, the row says why, and Solus does the
nearest thing.

| | macOS | Windows | Linux |
|---|---|---|---|
| Menu-bar item | Status item with the app's icon and title | Notification-area icon with the app's icon; the title is its tooltip and the first line of its menu (`tray.setTitle` is macOS only) | Tray icon (StatusNotifierItem) with the app's icon; title as on Windows |
| Menu-bar page | A click opens the popover under the item; a right click shows the menu | A click opens it above the item; a right click shows the menu | The menu's **Show <App> Popover** (a StatusNotifierItem gives no click); placed at the pointer on X11, by the compositor on Wayland (no window position there) |
| Global shortcuts | Yes | Yes | X11 yes; Wayland through the GlobalShortcuts portal |
| Keep on top | Yes | Yes | X11 yes, as the window manager allows; `unavailable` on native Wayland (`setAlwaysOnTop` is not supported there) |
| Start at login, workspace hidden | Login item; `wasOpenedAtLogin` (macOS 13 may ask in System Settings) | Run key with `--solus-login` | `~/.config/autostart` entry with `--solus-login` |
| Microphone, camera | The app's grant, then macOS's switch for Solus (asks once, then offers System Settings) | The app's grant, then Windows's privacy switch (a refusal offers Settings) | The app's grant (no system switch for a desktop program) |
| System audio | macOS 13 and later, with Screen & System Audio Recording; `NSAudioCaptureUsageDescription` | Yes (loopback) | PulseAudio or PipeWire's pulse server, with `PulseaudioLoopbackForScreenShare` |
| Badge | Dock count, added to the attention count | The app window's own taskbar button | Launcher count on a dock with the LauncherEntry API (Ubuntu Dock, KDE, Plank), added |
| Notifications | Yes | Yes | Yes, as the notification server allows a click |

Web and mobile: an app runs in Solus, not in a desktop window. Every
capability is unavailable there (`available: false`): a platform exception
(`docs/app-shortcuts.md` §6).

## 7. Order of work

1. Contracts (`packages/contracts/src/app-desktop.ts`), grants in the
   records, the rules of a permission state. Tests.
2. The main runtime (`apps/desktop/src/main/app-shortcuts/app-desktop.ts`)
   with its Electron parts behind small ports. Tests.
3. The menus as templates. Tests.
4. IPC, preload, the app windows' hooks, the media permission handler.
5. The relay in the renderer: the frame's bridge, `answerAppCall`,
   `SandboxFrame`, `AppWindow`.
6. `@solus/app`: `desktop` and the hooks; the create-app skill.
7. Settings → App permissions; a delete forgets the grants.
8. `docs/app-shortcuts.md`.

## 8. What Executor does, and what Solus does

The reference is Executor's `apps/local/desktop/src/implementation/installed-apps.ts`,
its preload `preload-app.ts`, and the app-side `packages/apps/src/implementation/desktop.ts`
and `react.ts`.

Taken as it is:

- The set of permissions, the four states, the native
  **Allow** / **Don't Allow** dialog one at a time, and its words.
- A refusal is never asked again; only the person changes it. A revoke applies
  at once: the item goes, the shortcuts go, the window comes down, and a revoke
  of the microphone or the camera reloads the window so a capture stops.
- The rules of a global shortcut (`shortcutProblem`): a modifier that is not
  Shift, or F13–F24 and the media keys alone; at most 8; `ShortcutTaken` when
  another program holds the keys.
- The app menu (Reload, Permissions with check items and the shortcuts in
  use, Remove from menu bar, the remove item, Close) and the tray menu.
- A window with a menu-bar item hides on close; Quit ends it.
- The badge: per-app counts added into the Dock count on macOS and Linux, the
  app window's own taskbar button on Windows.
- The login item for the first app that starts at login, and the System
  Settings offer when macOS 13 holds it for approval.
- Media requests in the session's permission handler go to the app's grants,
  then to `systemPreferences.askForMediaAccess` on macOS; any other request of
  the app's page is refused.
- The app-side API (`desktop`, `available`, the typed errors) and the hooks
  `useDesktopShortcut`, `useDesktopWindowEvent`, `useDesktopBadge`, and
  `useDesktopPermission`.

Done in another way:

| Executor | Solus | Why |
|---|---|---|
| A preload in the app's window exposes a frozen bridge global. | `@desktop/` calls on `window.solusApp`; the Solus page of the window relays them. | The app frame is a sandboxed frame with no origin: no preload reaches it (`docs/app-shortcuts.md` §7). |
| The app is named by its window's origin. | By the web contents of its app window (`AppWindows.targetOf`). | Every app window has the same Solus page; the app is not an origin. |
| The web `Notification` API, wrapped in the preload; `data.path` opens a path. | `desktop.notify({ title, body, route })`; the route is a page after `#`. | No preload reaches the frame, and an app's pages are routes after `#` (`create-app` ui.md). |
| `navigator.clipboard.readText()`, behind the grant. | `desktop.clipboard.readText()`. | The same: no origin. |
| A menu-bar item needs `ui/menubar.html`, and its click opens a popover. | `menubar.html` beside `index.html`, with `<meta name="solus:menubar">`. An app with no such page still gets an item when it sets a title. | A Solus app keeps its pages at the project root and its code in `src/`. B's title-only item stays for apps with no page. |
| System audio on Windows and macOS 13 and later. | Linux too, with Chromium's PulseAudio loopback. | The decision of §6: parity. |
| The login item is set to the wanted state at start. | Solus changes it only when the first app wants it or the last one stops, and turns off only what it turned on (`loginItemForApps`). | Executor's first sync turns off a login item that the person made. |
| A store of installed apps with a revision and an installation id. | The answers in `app-shortcut-records.json`, by app. | An app window needs no install in Solus. |
| An end-to-end test that drives Electron. | Unit tests with fakes for each Electron part. | Solus verifies with focused tests and no build (CLAUDE.md). |

## 9. Built later, and not in this plan

Built 2026-11-27: system audio and the menu-bar page in its popover. The app
window now loads a named page of the app (`app-window-page=menubar`), which
the host builds and serves by name (`appUi({ page: 'menubar' })`).

Not in this plan: a second window of an app (`desktop.window.open`).
