# Desktop remote-only mode

A person can turn off the host that the desktop app runs on their computer. The
app then only connects to saved hosts. This is a native-shell exception to the
multi-surface rule: web and mobile have no local host to turn off.

## Vocabulary

- **Local host** — the server that the desktop app runs in its main process.
- **Remote-only mode** — the desktop app with its local host off.

## Assumptions

- Only the windowed app reads the setting. `--headless` and `pair-url` keep
  their behavior, because a headless app exists to be a host.
- The setting belongs to this computer. It does not sync to the account.
- The setting applies at launch. A change relaunches the app.

## Behavior

Turning the local host off:

1. Main writes `local-host.json` in `userData`, and relaunches through the
   normal quit path, so running agents stop cleanly.
2. On the next launch, main does not load the server graph or start a server. It
   does not open the database. No local agent runs, and no device can connect.
3. `getLocalConnection()` answers `null`.
4. The renderer registers no local target. `hosts.device` is null, as on web.

All local data stays: the database, tokens, and settings are not read or changed.

Turning the local host on writes the file and relaunches. The host starts with
its earlier settings, because nothing changed them.

A missing file means on. A file that cannot be read means off: a person who
turned off the local host must not get a listening server because of a bad file.
The switch in Settings writes a good file.

## The window with no local host

The workspace already handles a host that is not there
(`docs/plans/workspace-and-machines.md` §6, `docs/plans/draft-connect-host.md`),
so the desktop mounts the normal workspace. It does not get a second home page.

- The primary is the active saved host, else the first host in the catalog.
- With no host, the primary is a `gone` connection. Its calls fail, and a draft
  shows the connect page. The first host that is saved or listed by the account
  becomes the primary (`ServerConnections.openWithoutLocalHost`).
- `window.solus` is the primary's API with the native methods on top, so the
  account, updates, and window methods work with no local host.

## References to the local host

The local host is off, not removed, so `reconcileMachineReferences` treats it in
one different way: a started tab stays open and read-only, and it says why. The
tab restores when the local host comes back. Unstarted runs move to a saved host,
because they must be able to run. The remembered project and the kept project
list are cleared as for any gone host. Both are read again from the host later.

## Why not an RPC method

With the local host off there is no server to answer an RPC, so the reverse path
cannot be one. A second path for the on state only adds a way to fail. The
setting is a method of the native bridge: `NativeSolusAPI.setLocalHostEnabled`.
It is in `NATIVE_ONLY_SOLUS_METHODS`, so `localApi` reads it. Web and mobile do
not have it, and no surface shows the control there.

## Surfaces

| Entry point | Behavior |
|---|---|
| Settings → Hosts | A switch. Turning it off asks for confirmation. |
| Command palette | Turn on directly. Turn off opens Settings → Hosts. |
| Connect page | A card that turns the local host on. |
| Read-only tab | Says that the local host is off and where to turn it on. |

## What needs the local host

These stop in remote-only mode, because the server does the work:

- Screenshots and the summon shortcut editor. The saved summon shortcut works.
- Open in terminal, reveal in Finder, and the native browser surface.
- Add over SSH from this computer. Pairing by address or code works.
- Voice uses the Run on host, as on web.

If this computer is linked to the account, the directory still lists it. The
window then shows it as an offline saved host, because it cannot know its own
installation id with no local host.

Machine policy (MDM) is still read, because it governs the update feed. An
organization's cloud policy for this computer comes from the host, so it does
not apply.

Analytics stays off. The desktop starts analytics only after it reads the policy
of its own host, and there is none.
