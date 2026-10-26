# Browser on a Linux server

Solus runs Chromium on the server and streams its display to connected desktop,
web, and mobile clients. Clicks, text, and scrolling return to that browser.
An app at `localhost` is accessed on the server. It does not need a public port
for the client to see it. No desktop session or display server is required.

Managed cloud images include the Chromium system libraries. A standalone server
archive includes the Playwright driver, but needs the following setup.

## The pinned Chromium

A standalone or managed server does not use the Chromium that Playwright
bundles. It uses one fixed Chrome for Testing build of `chrome-headless-shell`,
pinned in `packages/server/src/browser/pinned-chromium.ts`. The current pin is
156.0.8078.70.

Why: the headless shell does not load Chrome's CRLSet. It blocks a certificate
only through the SPKI blocklist that is compiled into Chromium. Builds before
156.0.8078.70 trust the compromised eMudhra intermediate CAs
([crrev.com/c/8627687](https://chromium-review.googlesource.com/c/chromium/src/+/8627687)).
Playwright 1.63 bundles 153.0.8010.12. No Playwright release bundles a fixed
build yet. Do not pin below 156.0.8078.70.

The server downloads the zip for its platform from
`storage.googleapis.com/chrome-for-testing-public`. It checks the byte count and
the SHA-256 in the pin before it unpacks the zip. It installs the build in
`SOLUS_DATA_DIR/chrome-for-testing/<platform>/<version>`, and removes older
versions from that directory. The download occurs when a page first opens, or
when an administrator selects **Install browser**. One download serves all
callers. Platforms: Linux x64 and arm64, macOS x64 and arm64, Windows x86 and
x64 (Windows on Arm uses x64).

The desktop app does not use this build. It shows pages in its own Electron
Chromium.

### When the server cannot download the pinned build

If the download fails (no network route to `storage.googleapis.com`, or a size
or SHA-256 mismatch), or Chrome for Testing has no build for the host, Solus
uses Playwright's own Chromium if it is installed. Pages continue to work, but
that Chromium trusts the compromised CAs. The server logs
`browser_pinned_chromium_unavailable` with the reason. After one failed
download, page launches do not try again until the server restarts or an
administrator selects **Install browser**. **Install browser** always tries the
download again, and shows the failure if it fails again.

Node's `fetch` does not use `HTTPS_PROXY` unless the service runs with
`NODE_USE_ENV_PROXY=1`. On a host behind a proxy, set it in the service
environment.

### Update the pin

1. Choose a version at or above 156.0.8078.70 that has a `chrome-headless-shell`
   zip for all six platforms. The versions are in
   [known-good-versions-with-downloads.json](https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json).
   A new build can be in the bucket before it is in that list.
2. Download each zip into a new, empty directory and record its size and SHA-256:

   ```sh
   V=156.0.8078.70
   for p in linux64 linux-arm64 mac-arm64 mac-x64 win32 win64; do
     curl -sfL -o "$p.zip" "https://storage.googleapis.com/chrome-for-testing-public/$V/$p/chrome-headless-shell-$p.zip"
     echo "$p $(wc -c < "$p.zip") $(shasum -a 256 "$p.zip" | cut -d' ' -f1)"
   done
   ```

3. Replace `PINNED_CHROMIUM_VERSION` and every byte count and SHA-256 in
   `pinned-chromium.ts`.
4. Run `bun test tests/unit/browser-pinned-chromium.test.ts`, then launch the new
   build once on a host before release. Servers download the new build when a
   page next opens.

When a Playwright release bundles a build at or above the minimum, the pin can
go. Until then, keep it.

## Install the browser

From any Solus client, open **Settings → Hosts → your host → Environment**
and select **Install browser**. Installation runs on that host and continues if
the client disconnects. Solus downloads the pinned Chromium and tests it before
it reports that it is ready. The action is available to the host administrator.
Desktop hosts already include a browser and do not need this download.

On Linux, if required system libraries are missing, Solus tries a
noninteractive administrator command. If that needs a password, the page shows a
command to run on the host. After completing that command, select **Check
again**.

Use a Debian or Ubuntu release supported by the packaged Playwright version.
To install the system libraries yourself, run this as root or with sudo. For the
default installer location:

```sh
SOLUS_CURRENT="$HOME/.local/share/solus/current"
sudo "$SOLUS_CURRENT/bin/node" \
  "$SOLUS_CURRENT/libexec/server/node_modules/playwright-core/cli.js" \
  install-deps chromium
```

Replace `SOLUS_CURRENT` if the server was installed elsewhere. The pinned
Chromium needs the same libraries as Playwright's Chromium.

Profile data remains in `SOLUS_DATA_DIR/browser-profiles`.

## Check the result

Start Solus, connect a client, and open a browser page for an app running on that
host. Confirm that the page appears and accepts clicks, text, and scrolling.
The normal Solus connection carries both frames and input.

If a page fails to open, check the server log for `browser_headless_open_failed`.
`browser_pinned_chromium_installed` confirms the pinned download.
`browser_pinned_chromium_unavailable` means that pages use Playwright's
Chromium, or no Chromium. Missing shared libraries mean that the system
dependency installation is incomplete. `browser_playwright_registered` confirms
the driver was loaded; it does not prove that Chromium can launch.
