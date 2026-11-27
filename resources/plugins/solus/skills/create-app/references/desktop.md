# The desktop app

An app with a UI can open in its own window of the Solus desktop app (macOS, Windows, Linux). There it can use native capabilities: a menu-bar item with its own page, global shortcuts, a window above others, a start at login, the microphone and the camera, system audio, the clipboard, notifications, and a badge. Each one but the badge and the window controls needs the person's answer.

Everywhere else (in the workspace, in Solus on the web, on a phone) the capabilities are absent. Check `desktop.available` and give the app a full experience without them. Do not tell the person to install anything.

```tsx
import { desktop, DesktopPermissionDenied, ShortcutTaken, SystemAudioBlocked, useDesktopBadge, useDesktopShortcut, useSystemAudio } from '@solus/app'
```

## Permissions

A new app has no answers. The first call that needs a permission shows a native **Allow** / **Don't Allow** dialog; the answer stays on that computer. After a refusal the call rejects with `DesktopPermissionDenied` and never asks again: only the person changes it, in the app window's menu (**Permissions**) or in Solus **Settings → General → App permissions**. Ask from a person's action, so the dialog makes sense, and show a quiet state when the answer is no.

| Permission | What it allows |
|---|---|
| `menuBar` | The menu-bar page (`menubar.html`), asked for when the app opens; `desktop.menuBar.setTitle` |
| `shortcuts` | `desktop.shortcuts.register`, `useDesktopShortcut` (8 an app) |
| `floating` | `desktop.window.setFloating(true)` |
| `startAtLogin` | `desktop.requestPermission('startAtLogin')`: the app opens with no window each time Solus starts, and Solus opens at login |
| `microphone`, `camera` | `navigator.mediaDevices.getUserMedia` |
| `systemAudio` | `desktop.audio.system()`, `useSystemAudio` |
| `clipboardRead` | `desktop.clipboard.readText()` |
| `notifications` | `desktop.notify` |

- `desktop.permission(name)` reads the answer without asking: `granted`, `denied`, `prompt`, or `unavailable`.
- `desktop.requestPermission(name)` asks now and resolves the answer; a refusal resolves `denied`.
- `useDesktopPermission(name)` is the answer as React state, read again when the window gains focus.

Errors: `DesktopUnavailable` (not in a desktop app window, or not on this computer), `DesktopPermissionDenied` (`.permission`), `ShortcutTaken` (`.accelerator`), `DesktopInvalidInput` (the input is out of range), `SystemAudioBlocked` (macOS has not allowed Solus to record system audio). Check them with `instanceof`.

## Menu bar

```tsx
async function showUnread(count: number) {
  if (!desktop.available) return
  try {
    await desktop.menuBar.setTitle(count > 0 ? `${count} unread` : null)
  } catch (error) {
    if (!(error instanceof DesktopPermissionDenied)) throw error
  }
}
```

### The menu-bar page

An app can ship a small second page that opens in a popover under its menu-bar item, as a status app does. Add `menubar.html` beside `index.html`, with the same two markers and a size, and its entry `src/menubar.tsx`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="solus:menubar" content="width=320, height=240" />
    <title>Notes</title>
    <!-- artifact:styles -->
  </head>
  <body>
    <div id="root"></div>
    <!-- artifact:script -->
  </body>
</html>
```

`src/menubar.tsx` mounts its own small React tree, as `src/main.tsx` does, and shares `src/styles.css`. It uses the same `@solus/app` calls and data. The size is in CSS pixels: width 200–640, height 120–720 (320 × 400 when the meta is absent). The build fails when one of the two files is there without the other.

When the app opens in its window, Solus asks for `menuBar` once and shows the item. A click on the item opens the page under it; a click away closes it. On macOS a right click shows the item's menu; on Linux the item's menu has **Show <App> Popover**, because a Linux tray icon gives no click. The page runs only while the popover shows: keep its state in the app's data, not in the page.

### The title

The text is at most 24 characters; `null` shows the app's name. On macOS it is in the menu bar; on Windows and Linux it is the tooltip of a tray icon. The item's menu opens the app, reloads it, shows its permissions, and quits it. While the item shows, closing the window hides it and the page keeps running, so the title and the shortcuts stay live. A reload of the window removes the title until the page sets it again.

## Global shortcuts

```tsx
function SearchShortcut({ onOpen }: { onOpen: () => void }) {
  const error = useDesktopShortcut('CommandOrControl+Shift+K', () => {
    void desktop.window.focus()
    onOpen()
  })
  if (error instanceof ShortcutTaken) return <p>{error.accelerator} is in use by another app.</p>
  if (error instanceof DesktopPermissionDenied) return <p>Keyboard shortcuts are off for this app.</p>
  return null
}
```

Use Electron's accelerator syntax. A shortcut needs CommandOrControl, Control, Command, Alt, or Super; Shift alone is refused, and only F13–F24 and the media keys work alone. `desktop.shortcuts.register(accelerator, handler)` resolves the function that removes it. A shortcut works while the window is hidden and goes when the window closes.

## Notifications

```tsx
await desktop.notify({ title: 'Report ready', body: 'Q3 revenue', route: `#/reports/${id}` })
```

A click brings the window to the front; `route` sets the page after `#` ([ui](ui.md#pages)). The web `Notification` API does not work in an app's page.

## The window

- `desktop.window.setFloating(on)` keeps the window above other windows (`floating`).
- `show()`, `hide()`, `focus()`, and `toggle()` change the app's window. `hide()` keeps the page running.
- `desktop.window.onFocus(handler)` and `onBlur(handler)`, or `useDesktopWindowEvent('blur', handler)`, follow focus.

## Badge

`desktop.badge.set(count)` (1 to 99999; `null` or 0 removes it), or `useDesktopBadge(count)` while a component is mounted. No permission. On Windows it is on the app window's own taskbar button; on macOS and Linux the counts of all apps add into the Solus icon.

## Microphone and camera

Call `navigator.mediaDevices.getUserMedia({ audio: true })` from a person's action. Solus asks for the permission, then for the operating system's access. Call `desktop.requestPermission('microphone')` first to show your own state before the recording starts. A revoke reloads the window, so a capture that runs stops.

## System audio

```tsx
function Recorder() {
  const audio = useSystemAudio()
  if (!desktop.available) return null
  if (audio.error instanceof SystemAudioBlocked) return <p>Allow Solus under Screen & System Audio Recording in System Settings, then reopen Solus.</p>
  if (audio.error instanceof DesktopPermissionDenied) return <p>System audio is off for this app.</p>
  return audio.stream
    ? <button onClick={audio.stop}>Stop</button>
    : <button onClick={() => void audio.start()}>Record what this computer plays</button>
}
```

`desktop.audio.system()` resolves everything this computer plays, such as the other people in a call, as an audio-only `MediaStream`; `useSystemAudio()` holds one while a component is mounted. Call it from a click or a key press. The first call asks for `systemAudio`; after that question the person can need to click again. Stop the tracks when you are done. A revoke reloads the window, so a capture that runs stops.

- macOS 13 and later: macOS also asks Solus for Screen & System Audio Recording; without it the call rejects with `SystemAudioBlocked`, after Solus offers System Settings. macOS applies that access after Solus reopens.
- Windows: no other question.
- Linux: the audio of the default output, through PulseAudio or PipeWire's pulse server. A computer with neither rejects with `DesktopUnavailable`.
- Before macOS 13, `desktop.permission('systemAudio')` is `unavailable` and the call rejects with `DesktopUnavailable`.
