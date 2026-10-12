# Headless server build

A headless build includes the standalone server and CLI without the web client or
Electron app. Desktop and mobile clients connect through the existing server API.
The health, authentication, pairing, and WebSocket routes remain available. The
server does not serve a web workspace when `libexec/client` is absent.

Compile the current server and CLI source, including database migrations:

```sh
bun run build:standalone-server
```

Output is in `dist/headless/libexec/server` and `dist/headless/libexec/cli`. This
command uses esbuild and does not run Electron, Vite, or a frontend build. It does
not include Node or the other release resources; use the package command for an
installable archive.

Package a headless server for a target host:

```sh
bun run package:server --headless --platform linux --arch x64
```

The archive is `release/solus-server-headless-linux-x64.tar.gz`. It includes the
Node runtime, server, CLI, migrations, launchers, plugins, and browser driver.
Chromium still needs a separate install on the target host. No existing desktop
or web client build is required. The archive has a separate name so it does not
replace the standard package. `release/SHA256SUMS` includes both package variants.

Without `--headless`, the package command still includes the existing web client
build from `dist/client`. It requires that client build, but no desktop build.

Deploy the current source with the web client to an SSH host:

```sh
bun run deploy:server -- 10.10.1.79
```

This command builds only the web client, packages the server from source for the
host's operating system and architecture, and installs it in `/opt/solus`. It
restarts `solus.service` and checks `/health`. If startup fails, it restores the
previous installation. The command does not build the desktop app.

The server release workflow packages with `--headless` and publishes that archive
under the standard `solus-server-<platform>-<arch>.tar.gz` name. The published
installer and automatic updates therefore install a headless server. They do not
need a new archive naming rule. The web workspace is absent from these releases;
use a desktop or mobile client to connect to the host.

For local network discovery, allow UDP port `34117` from the local subnet in the
host firewall. Also allow the server's TCP port (default `3000`) for client
connections. Discovery broadcasts stay within the local network. The mobile app
also sends the discovery query directly to each address in its /24, so a host
must answer UDP `34117` from any local address, not only broadcasts.
