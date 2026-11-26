# Running servers

An automatically detected port appears in **Running servers** after the host has seen the same process listening on that port for at least 15 seconds. A configured URL appears as soon as it responds. The list removes a port when a scan no longer finds it. Browser previews can use detected ports as soon as the host finds them.

The provider logo identifies the agent that started the server. It stays the same when a session switches providers. When the host cannot identify the launch provider, the project panel shows a bot icon and the mobile sheet shows **Agent**.

On macOS and Linux, the host reads the provider tag from the server process or a parent process. On Windows, it looks for a provider process in the parent chain that runs under this Solus host. The host stores the launch source in memory as soon as it identifies the server. Later scans reuse it while they can verify the same process is alive.
