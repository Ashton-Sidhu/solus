# Desktop capabilities of an app window

Status: built 2026-11-27 in the desktop app; not exercised on a real machine (`docs/app-shortcuts.md` §7). Builds on `docs/app-shortcuts.md` (app windows and
app shortcuts). The reference is Executor (`UsefulSoftwareCo/executor`, branch
`v2`, `apps/docs/content/desktop-apps.mdx`).

## 1. Vocabulary

- **desktop capability** — a native ability that an app has in its app window:
  a menu-bar item, a global shortcut, keep on top, start at login, the
  microphone, the camera, a read of the clipboard, a notification, a badge,
  and the controls of its own window.
- **permission** — a desktop capability that needs the person's answer before
  the app uses it. There are eight: `menuBar`, `shortcuts`, `floating`,
  `startAtLogin`, `microphone`, `camera`, `clipboardRead`, `notifications`.
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
5. The grants are on this device: `app-shortcuts.json` keeps them beside the
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

Failures: `DesktopUnavailable`, `DesktopPermissionDenied { permission }`,
`ShortcutTaken { accelerator }`, `DesktopInvalidInput { message }`. The frame
gives the page an `Error` whose `name` is the code; `@solus/app` makes each one
its own class.

The page learns of events through `solusApp.on(listener)`: `desktop-shortcut
{ id }`, `desktop-window { type: focus | blur }`. A click on a notification
with a `route` (`#/reports/42`) brings the window to the front and sets
`location.hash` in the page (the frame's bridge does this).

The microphone and the camera are `navigator.mediaDevices.getUserMedia`: the
frame of an app window allows them, and the main process's permission handler
asks for the grant, then for the operating system's access.

`window.solusApp.desktop` is `true` only in a desktop app window.
`@solus/app` exports `desktop` (with `available`) and the React hooks
`useDesktopShortcut`, `useDesktopWindowEvent`, `useDesktopBadge`, and
`useDesktopPermission`. Outside an app window `available` is false,
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
  turns off a login item that it did not turn on.

## 5. The menus

App menu: **Reload**, **Permissions** (a check item for each permission),
**Remove from menu bar** when it has an item, **Remove <App> shortcut…** when
it has a shortcut, **Close Window**, **Quit <App>**. On macOS it is after the
Solus menu and before Edit and Window; the workspace window gets back the
menu it had.

Tray menu: **Open <App>**, **Reload**, **Permissions**, **Remove from menu
bar**, **Quit <App>**.

## 6. What each operating system supports

| | macOS | Windows | Linux |
|---|---|---|---|
| Menu-bar item | Status item with the title | Notification-area icon; the title is its tooltip | Tray icon (StatusNotifier); title as tooltip |
| Global shortcuts | Yes | Yes | X11 yes; Wayland through the portal |
| Keep on top | Yes | Yes | Depends on the window manager |
| Start at login | Login item (macOS 13 asks in System Settings) | Run key | `~/.config/autostart` entry |
| Microphone, camera | Asks macOS too | Yes | Yes |
| Badge | Dock count, added to the attention count | The app window's own taskbar button | Launcher count (Unity API), added |
| Notifications | Yes | Yes | Yes |

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

- The set of permissions (without system audio), the four states, the native
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
| A menu-bar item needs `ui/menubar.html`, and its click opens a popover. | Any app that sets a title gets an item with a menu; no popover. | The popover is a second page; §9. |
| The login item is set to the wanted state at start. | Solus changes it only when the first app wants it or the last one stops, and turns off only what it turned on (`loginItemForApps`). | Executor's first sync turns off a login item that the person made. |
| A store of installed apps with a revision and an installation id. | The answers in `app-shortcuts.json`, by app. | An app window needs no install in Solus. |
| An end-to-end test that drives Electron. | Unit tests with fakes for each Electron part. | Solus verifies with focused tests and no build (CLAUDE.md). |

## 9. Not in this plan

System audio, the menu-bar popover page, and a second window of an app
(`desktop.window.open`). Each needs a second page of the app in its own
window, and the app frame today has one page.
