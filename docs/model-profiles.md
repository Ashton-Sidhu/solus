# Model list

The model list tells Solus which models each provider offers, their labels,
their effort levels, their context windows, and which model is the default.
The list is `packages/contracts/src/model-profiles.json`.

## Release a model without a new build

The file on `main` is the published list. To add, change, or retire a model:

1. Edit `packages/contracts/src/model-profiles.json`.
2. Merge the change to `main`.

Each host downloads the file from
`https://raw.githubusercontent.com/Ashton-Sidhu/solus/main/packages/contracts/src/model-profiles.json`
once a day at 15:00 New York time (`America/New_York`, so the time follows
daylight saving time). Clients get the list from their host. A new model shows
in the model picker on desktop, web, and mobile after the next check, or at once
after a user clears the cache in Settings → About Solus.

A model works only if the provider CLI installed on the host accepts its ID.
The list does not install or update Claude Code or Codex.

## How a host gets the list

`ModelProfilesService` (`packages/server/src/updates/model-profiles-service.ts`)
owns the host's list:

- **Boot.** The host starts on the list its build shipped with. If it has a
  cached download in `~/.solus/model-profiles.json` (or `SOLUS_DATA_DIR`), it puts
  that list in effect before it serves a turn.
- **Daily check.** When 15:00 New York time has passed since the last check, the
  host downloads the file. A host that was off or asleep at 15:00 checks when it
  starts or within one hour of waking.
- **Validation.** The download must match the schema in this build
  (`modelProfilesSchema`). A list with a field or effort level this build does not
  know is refused. The list in effect stays, and the settings row shows the error.
- **Cache.** A good download replaces the list in effect and the cache.

The list in effect is `MODEL_PROFILES` in `@solus/contracts/types`.
`replaceModelProfiles` changes it in place, so code that holds a provider's map
reads the new list. Read `MODEL_PROFILES` when you use it. Do not copy a
provider's models into a constant at import. The agent backends build their
`metadata` from `providerModelsFor` on each read for this reason.

## RPC and events

| Name | Kind | Access | Purpose |
|---|---|---|---|
| `modelProfilesStatus` | method | any member | The list in effect, its source (`bundled` or `remote`), when it was downloaded, and the last error. |
| `modelProfilesRefresh` | method | host admin | Deletes the cache and downloads the list now. If the download fails, the host goes back to the list in its build. |
| `host.modelProfilesChanged` | event | every client | The whole status, sent when the list or the check state changes. |

Hosts advertise the `modelProfiles` capability. A client connected to an older
host uses the models that host lists in `start()`.

## Clients

`modelProfilesStore` (`packages/workspace-ui/src/contexts/updates/model-profiles.store.svelte.ts`)
reads the status from each connected host and puts the newest download in effect.
All hosts download the same file, so the most recent download is the best answer.
`AgentContext.metadata` reads the store's `revision`, so an open model picker shows
a new list when it arrives.

Settings → General → **About Solus** → **Model list** shows where the list came
from and when it was downloaded, for the host this window uses
(`serversStore.activeServer`: the local host on desktop, the primary connection on
web and mobile). **Clear cache and refresh** calls `modelProfilesRefresh`. The
section is in the shared settings page, so desktop, web, and mobile show it.

## Development

Set `SOLUS_MODEL_PROFILES_URL` to download the list from a different URL, for
example a branch:
`https://raw.githubusercontent.com/Ashton-Sidhu/solus/<branch>/packages/contracts/src/model-profiles.json`.

A local edit to `model-profiles.json` is replaced by the published list after the
host's first check. To test a local edit, point `SOLUS_MODEL_PROFILES_URL` at a
file server that serves your copy, or clear the cache while offline to run on the
bundled list.
