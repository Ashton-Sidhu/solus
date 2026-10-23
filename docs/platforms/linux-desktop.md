# Linux desktop

Solus builds Linux x64 AppImage and Debian packages. The app uses glibc. ARM64, musl, RPM, Flatpak, and Snap are outside this release scope.

The marketing site's download button offers the x64 AppImage to Linux visitors (`/api/download?platform=linux`). The release workflow uploads a stable `Solus-latest-x86_64.AppImage` object for the site. The Linux link works after a Linux release uploads that object.

## Install and run

For AppImage, make the file executable, then run it. The host needs FUSE 2 support. If FUSE is not available, use `--appimage-extract-and-run`. Keep the AppImage in a directory that you can write to if you use automatic updates.

For Debian, install the `.deb` with your package manager. The app appears as Solus in the application menu. Debian updates are manual: Settings → About Solus opens the release download page. Install the new package to update. Solus does not request administrator access when it quits.

The stable desktop entry is `com.solus.app.desktop`. Closing the workspace hides it. Use the tray or launch Solus again to show the existing window. A second launch uses the same app and host. On Wayland, the compositor controls window placement and focus. Global shortcuts use the desktop portal where available; if a key is denied or already used, choose another shortcut in Settings.

## Screenshots and terminals

The Add menu and screenshot shortcut use the local desktop screenshot portal, even when the session runs on a remote host. Install `xdg-desktop-portal` and the backend for your desktop. The backend controls region selection and consent. Cancel returns to the composer without an attachment. Capture errors appear as a message. Captured image bytes are uploaded to the selected host; app-owned temporary files are removed. Portal-owned source files are not deleted by Solus.

Terminal actions need tmux and a supported terminal. Default Terminal selects an installed terminal. Linux keeps Solus visible because a compositor can refuse to activate a terminal window. Switch to the terminal after command delivery. A missing terminal or failed launch reports an error.

## Secure storage

Cloud sign-in and encrypted host credentials need a working system keyring, such as GNOME Keyring or KWallet. Solus rejects Electron's insecure `basic_text` backend. Unlock or install the keyring, then retry sign-in. Local work remains available without cloud sign-in. Existing encrypted records are not deleted when a keyring read fails.

## Build and verification

Build the desktop and web bundles in sequence, then run `electron-builder --linux --x64 --publish never`. The package hook checks native file search, ONNX inference, and Claude SDK loading before it sets Electron's security fuses. The Ubuntu 22.04 CI jobs repeat these checks and run the packaged app on X11.

Run `node scripts/verify-linux-desktop.mjs x11 release/linux-unpacked/solus` to check an existing unpacked package. Use `wayland` on a Wayland desktop. The script sets temporary Electron userData, server data, and provider configuration directories, keeps the Chromium sandbox enabled, and stops only the processes it starts. Screenshots and logs go to `.solus-local/linux-verification/`. A real portal capture requires an interactive desktop; its optional region-selection driver is for the Omarchy verification host.

The implementation record is `docs/plans/linux-desktop-results.md`. That record lists the exact checks and untested release cases. An X11 CI smoke test does not prove GNOME, KDE, real Wayland consent, or an AppImage update from one released version to another.
