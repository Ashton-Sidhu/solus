# Browser on a Linux server

Solus runs Chromium on the server and streams its display to connected desktop,
web, and mobile clients. Clicks, text, and scrolling return to that browser.
An app at `localhost` is accessed on the server. It does not need a public port
for the client to see it. No desktop session or display server is required.

Managed cloud images include Chromium and its system dependencies. A standalone
server archive includes the Playwright driver, but needs the following setup.

## Install the browser

From any Solus client, open **Settings → Connections → your host → Environment**
and select **Install browser**. Installation runs on that host and continues if
the client disconnects. Solus tests Chromium before it reports that it is ready.
The action is available to the host administrator. Desktop hosts already include
a browser and do not need this download.

On Linux, Solus first downloads Chromium as the service user. If required system
libraries are missing, it tries a noninteractive administrator command. If that
needs a password, the page shows a command to run on the host. After completing
that command, select **Check again**. The same action can install the browser
revision required after a server update.

Use a Debian or Ubuntu release supported by the packaged Playwright version.
Run these commands as the OS user that runs the Solus service. For the default
installer location:

```sh
SOLUS_CURRENT="$HOME/.local/share/solus/current"
"$SOLUS_CURRENT/bin/node" \
  "$SOLUS_CURRENT/libexec/server/node_modules/playwright-core/cli.js" \
  install --with-deps chromium
```

Replace `SOLUS_CURRENT` if the server was installed elsewhere. Installation of
Linux system libraries needs root or sudo. Chromium is downloaded to the user's
browser cache. Do not run the entire command as another user: the service must
be able to find the same cache.

If an administrator must install the libraries separately, run `install-deps
chromium` with administrator rights, then run `install chromium` as the service
user. If you set `PLAYWRIGHT_BROWSERS_PATH`, use the same path during installation
and in the service environment, and give the service user read and execute access.

Repeat the browser installation after a Solus update. A newer Playwright driver
can require a different Chromium revision. Profile data remains in
`SOLUS_DATA_DIR/browser-profiles`.

## Check the result

Start Solus, connect a client, and open a browser page for an app running on that
host. Confirm that the page appears and accepts clicks, text, and scrolling.
The normal Solus connection carries both frames and input.

If a page fails to open, check the server log for `browser_headless_open_failed`.
A missing executable means that the browser revision or cache path is wrong.
Missing shared libraries mean that the system dependency installation is incomplete.
`browser_playwright_registered` confirms the driver was loaded; it does not prove
that Chromium can launch.
