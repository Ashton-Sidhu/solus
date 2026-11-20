# MCP F1 handoff: resource lists, the read tools, and the attach

Branch: `solus/mcp-resource-lists-and-attach`, from `4908f45fc` (the wave 3
merge). Nothing was pushed. No pull request was opened. F1 is §11.1 to §11.4 of
`mcp-first-class.md`; the watch (§11.5) is F2.

## What is built

**Server.**

- `integrations/resource-lists.ts`: `listUpstreamResources(client, now)` reads
  `resources/list` and `resources/templates/list` page by page, at most 200
  entries each (`MAX_LISTED_RESOURCES`), with the smallest `ttlMs` of the pages.
  `expandUriTemplate(template, values)` expands `{name}` and `{+name}` and
  refuses every other operator, and a missing value, with the reason.
  `readAsContent(result)` makes a `resources/read` answer into `resource`
  content blocks, so `agentResultOf` (§6) maps a read as it maps a tool result.
- `IntegrationGateway.resourcesFor(integrationId, personKey, starter)`: the
  lists of one person, cached by session key. A `resources` list-changed
  notification drops the list and calls the facts listeners, which send
  `integration.changed` with `change: 'facts'`. A closed session, `invalidate`,
  and `forget` drop it too. Without a `starter`, a `stdio` integration that is
  not running answers no resources: a list never starts a command.
- `readAppResource` is now `readResource`: it reads for an MCP App, an attach,
  and the agent. `connectionRequired` is public, for the resource tools.
- `integrations/resource-tools.ts`: `list_integration_resources` (`server?`,
  `cursor?`; pages of 100, a template entry has `uriTemplate`) and
  `read_integration_resource` (`server`, `uri`). They join a run when one of the
  run's servers that listed in time declares `resources`
  (`integrationToolbox`), reach only those servers by slug, are deferred, and
  need no approval. A read answers `CONNECTION_REQUIRED` and raises the connect
  card when the person has no connection.
- The resource link line of §6 gains "Read it with `read_integration_resource`,
  server `<slug>`." when the server declares `resources`
  (`ResultContentOptions.resourceServer`).
- `integrations/resource-attach.ts`: `attachResource` reads as the caller,
  expands a template, and keeps each content item (at most 8, each at most
  10 MB) in the conversation's folder of the attachment store
  (`storeAttachmentBytes`, split out of `storeAttachment`). A blob whose bytes
  are PNG, JPEG, GIF, or WebP is an `image` attachment; anything else is a
  `file`. The file name is the listed title or name, else the last part of the
  URI, with an extension for known types.
- `runIntegrations(source, actor, projectPath)` in `integration-tools.ts` is the
  one rule for which integrations join a run; the toolbox and the list RPC use
  it.

**Contracts.** In `integration-types.ts`: `IntegrationResource`,
`IntegrationResourceTemplate`, `IntegrationResourceLists`,
`integrationResourceListRequestSchema`, `integrationResourceAttachRequestSchema`.
RPC: `integrationResourceList(request)` (`host.use`, the caller's
integrations, a server that does not answer in 10 seconds left out) and
`integrationResourceAttach(ctx, request)` (`drive.attach` on the session,
as `attachUpload`; it needs a session or a draft). Both are on the execution
plane.

**Desktop and web.** `settings/integration-resources.store.svelte.ts` reads the
list once for each host and project when `@` first opens and again on
`integration.changed`. `rows.ts` adds the "MCP resources" band after the files
(at most 5), and `@<slug>:` lists only that server (at most 8). Matching runs on
the store's list: the title, then the server name and URI in the meta. Accepting
a row removes the `@` run and calls `onResource`, which the input bar passes
(`composer-commands.svelte.ts` `attachResource`). The document editor passes no
`onResource`, so its `@` lists files only. The chip comes at once;
`attachmentUploads.read` shows it as reading (a spinner, not a percent), as
failed with Retry ("Could not read <name>: <reason>" in the title and the
accessible name), and puts the host's attachments in its place. A prompt sent
while the chip reads waits for it, as for an upload. The footer verb is
"attach" on a resource row.

**Mobile.** The + menu (`ComposerAttachmentButton`) gains **MCP Resource…**.
`IntegrationResourcePicker.tsx` lists the servers and their resources with a
search field; `use-integration-resources.ts` reads the list when the sheet
opens and on `integration.changed`. `ConversationController.attachResource`
counts the read as an upload, so a prompt sent meanwhile waits for it; a failed
read gives a notice, as a failed upload does.

## Which existing element each new element follows

| New element | Follows |
|---|---|
| "MCP resources" band label in the `@` menu | the "Files" band label (`rows.ts`, `label` row) |
| Resource row in the `@` menu | the file row (`fileMenuItem`): same row grammar, a 14×14 stroked glyph (`GLYPH.resource`), mono meta |
| Dead end of `@<slug>:` with no match | the "No file matches" dead end |
| Resource chip | the file attachment chip in `AttachmentChips.svelte`; the server logo at 14px stands where `FileIcon` stands, as `McpServerIcon` draws a logo |
| Reading spinner on the chip | the image upload spinner (`LoaderCircle`, `motion-safe:animate-spin`) |
| Failed chip with Retry | the failed streamed-upload chip (`RotateCw`, `text-(--destructive)`) |
| Mobile "MCP Resource…" menu action | "Reference Session…" in `ComposerAttachmentButton` |
| Mobile resource sheet | `SessionReferencePicker.tsx`: the same page sheet, header, Cancel, search field, and row |
| Mobile server section label | the thread list section label (`ThreadListV2Section`: `text-xs font-t3-medium text-foreground-tertiary` and a hairline) |

F1 adds no dialog, so the "no outline border" rule had nothing to change here.

## Decisions taken without the maintainer

- **Templates in the clients wait for E.** The plan says selecting a template
  opens the argument form of §10, which E builds. E is not merged here. The host
  side is done (`integrationResourceAttach` with `uriTemplate` and `arguments`,
  and the expansion), and the agent sees templates. The `@` menu and the mobile
  sheet list resources only. E or a follow-up adds the template rows.
- **A list starts no command.** A `stdio` server that is not running has no
  resources in the menu or the sheet until it runs. The agent's tools start it
  for the run's person, as a tool call does.
- **Mobile failure is a notice.** The mobile composer shows a failed upload as a
  notice and has no Retry chip; a failed read does the same.
- **The server logo on the chip** is a client-side record of which attachment
  came from which server (`integrationResources.chipIcon`). `Attachment` gains
  no member, as §11.3 says; a chip restored from a saved draft shows the file
  icon.

## Open items

1. **Input outside a turn (§3 rule 7).** A read from an attach has no call, so
   the gateway declines a server's elicitation (`elicitFromCall` with no call).
   The client gets the server's own error, not "This needs input that Solus can
   only ask for during a turn." The agent's read also has no question card: it
   declines the same way. Both need the gateway to route an elicitation of a
   read; neither is a regression.
2. **A read with several content items** while a prompt waits for it: the
   prompt gets the first item only; the others stay in the composer. A read
   that comes back before the send gives the prompt all of them.
3. **Templates in the clients** (above).
4. **`integration.changed` per host** is followed once and never released when a
   host is removed (`integration-resources.store.svelte.ts` `followed`).

## Tests and checks

- `tests/unit/integrations/resources.test.ts` (new, 5): lists and the cache,
  the list-changed drop; the tools join only with a server that has resources
  and refuse another server; a read maps text, an image, and a blob; an attach
  gives a store file and an `Attachment`, an image by its bytes, and a
  `{+path}` template; `{?q}` and a missing value are refused; the resource link
  line.
- `tests/unit/mcp-resource-menu.test.ts` (new, 4): the band after the files,
  URI match, no band when nothing matches, `@<slug>:`, and an unknown slug.
- `tests/unit/native-mobile-resource-attachments.test.ts` (new, 3): sections by
  server, search by title and URI, and the attachment mapping.
- `gateway.test.ts`: two assertions now filter the server's own tools; its fake
  server lists a resource, so the two resource tools join, as §11.2 says.
- `bun test tests/unit/integrations/`: 272 pass, 0 fail. With the two new
  client tests, `access-policy`, and `rpc-planes`: 319 pass, 0 fail.
- `bun run check`: server 129, workspace-ui 39, contracts 0, mobile 0: the same
  as the base. `svelte-check` reports nothing new in the changed Svelte files.
- `oxlint` on the new files: clean. `lint:surfaces` clean.
- The same failures as the base: `agent-tool-schema-size` (110,064 against
  107,583, unchanged: the resource tools are per run, not in the Solus tool
  list) and `server-module-boundaries` (the three `host/` imports).
  `unified-autocomplete.test.ts` cannot load in this install (`runed` from
  `svelte-sonner`); the base version of `autocomplete.svelte.ts` fails the same
  way, so the new row tests are in their own file.

## Not run

No client was run: no desktop, web, or mobile build, and no screenshots. The
visual pass that the maintainer planned covers the new UI. No real provider
turn ran.
