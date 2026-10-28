# Webhooks — let other services start agent work

Status: proposed 2026-10-28. Decisions marked **(decided)** come from the maintainers. The other decisions are proposals that need sign-off.

Builds on: `docs/adr/0001-standard-authentication.md` §2.2 (the host tunnel), `solus-cloud/docs/plans/009-organization-vms.md` (record homes and managed hosts), `docs/plans/organization-scope.md` (ownership), `docs/cloudflare-managed-hosts.md` (managed hosts), the automations domain (`packages/server/src/execution/automations/`), and session orchestration (`docs/session-orchestration.md`).

Companion plan: `solus-cloud/docs/plans/webhook-forwarder.md` (the cloud forwarder and the offline inbox).

Reference: T3 Code has webhooks as a trigger type of its scheduled tasks, with a cloud relay that can hold requests (`pingdotgg/t3code`, `apps/server/src/scheduledTasks/webhook*.ts`, `infra/relay/src/hooks/`). We take its request handling, its prompt safety, and its offline holding. We do not take its model: in Solus a webhook is its own domain, and an automation is only one of its actions.

## 0. Why

Users want outside events to start agent work: a new pull request, a failed CI job, a new issue, a finished deploy. Today an automation starts only on a clock or by hand, and Solus learns about GitHub only by polling. The user must watch the event and then type the prompt.

## 1. Vocabulary

- **Webhook**: a record on a host. It has a secret URL, request checks, and a list of actions. It is not a trigger of an automation.
- **Receiver**: the route on the host that accepts a request for a webhook: `/hooks/<webhookId>/<token>`. The token is the credential.
- **Forwarder**: the Solus Cloud Worker at `hooks.solus.sh`. It sends a request to the host's receiver. It does not know tokens and it does not run actions.
- **Inbox**: the forwarder's store of requests for one host while that host is offline.
- **Held request**: a request in the inbox.
- **Cloud URL**: `https://hooks.solus.sh/<hostId>/<webhookId>/<token>`. The URL of a webhook on a linked host.
- **Direct URL**: `<host public URL>/hooks/<webhookId>/<token>`. The receiver at the host's public URL.
- **Host public URL**: a new host setting. The address where the user exposes the host (a reverse proxy, ngrok).
- **Delivery**: one request that came to the receiver, and what Solus did with it.
- **Action**: one thing a delivery does. A webhook has one or more actions (fan-out).
- **Action result**: the outcome of one action for one delivery.
- **Filter**: a test on the request, such as `headers.x-github-event equals pull_request`. Filters belong to an action. An action runs only when all its filters match. A webhook has no filters of its own.
- **Verification**: a check that a request comes from the expected sender, in addition to the URL token. It uses one of the generic schemes in §3.7.
- **Secret request**: an agent asks the user for a secret through a private card. The value never goes into the transcript or to the model. The agent gets a one-use **secretRef**.
- **Template**: the prompt text of an action, with `{{body.path}}`, `{{headers.name}}`, `{{query.name}}`, `{{body}}`, and `{{request}}`.
- **Replay key**: a template, for example `{{headers.x-github-delivery}}`. A second delivery with the same key is a duplicate and starts nothing.
- **Dry run**: a test of a sample request. It shows the filter results and the rendered prompts, and it starts nothing.

## 2. Hosts and the cloud

### 2.1 Where things live (proposed)

The webhook lives on the host that runs its work: the record, the token, the verification secret, the deliveries log, and the actions. The cloud never sees a verification secret, never checks a token, and it never runs an action. This is the model of automations, and it works without a Solus account.

Agents run only on hosts. The cloud Solus API (`mode: 'solus-api'`) does not receive webhooks.

### 2.2 Two URL modes (decided)

| Host state | URL the editor shows | When the host is offline |
| --- | --- | --- |
| Linked to Solus Cloud (laptop, self-hosted, or managed) | Cloud URL | The forwarder holds the request (§2.3). For a managed host, the request wakes the host. |
| Not linked, host public URL set (also a self-hosted server without a Solus account) | Direct URL | The user owns reachability. The sender gets an error. Nothing is held. |
| Not linked, no host public URL | The path only, with this text: "Link this host to Solus Cloud, or set its public URL." | — |

The receiver is the same in both modes. The forwarder only sends the request to it. So:

- The direct URL also works on a linked host, if the user exposes the host in another way.
- The token check and verification are in one place.

The cloud URL contains the host ID, so the forwarder needs no list of webhooks and no sync. The cost: a webhook cannot move to another host and keep its URL. This is acceptable for version 1.

**Link changes.** When a host unlinks, its cloud URLs stop working. The unlink confirmation says: "N webhooks use the Solus Cloud URL. Their senders must get the new URL." The editor of each webhook shows the current URL and marks a URL that changed since the user last copied it.

### 2.3 Holding requests while the host is offline (decided)

- **Default on** for every linked host. Each host has an off switch: **Hold webhooks while offline**, in host settings. The setting is stored in Solus Cloud, because the forwarder applies it.
- **Limits:** 1 MiB for each request, 24 hours, and 1,000 requests for each host. A request over a limit gets an error, and the cloud counts it as lost.
- **Encrypted at rest** with a key that only the forwarder has, in addition to the storage encryption of Cloudflare.
- **Order:** the forwarder delivers held requests for one host one at a time, oldest first. A `429` from the host means "try later": the forwarder keeps the request and continues after the minute.
- **What the sender sees:** `202` with `{"held": true}`. The real outcome is only in the host's deliveries log.
- **Lost requests:** when the host drains its inbox, the forwarder also sends one number for each webhook ID: the requests that it dropped at a limit or that expired. The deliveries log shows: "3 requests were lost while this host was offline (not verified)." "Not verified" is correct because the forwarder does not check tokens.
- **Off switch:** when the user turns holding off, the forwarder deletes the held requests of that host. When a host unlinks or is deleted, the forwarder deletes its inbox.

### 2.4 Offline and online signals (proposed)

Solus Cloud has no presence signal for a personal host today. The forwarder does not need one:

- **Offline:** the forwarder tries to send. If the tunnel does not answer (Cloudflare 530 or 502, 504, a network error, or no answer in 30 seconds), the forwarder holds the request.
- **The host answered:** every receiver answer has the header `x-solus-hook-outcome`. An answer with this header is final, also `404` or `401`. The forwarder passes it to the sender and holds nothing. An old host without a receiver gives a `404` without the header. The forwarder passes it to the sender and does not hold it.
- **Online again:** the host asks Solus Cloud to drain its inbox (control token) when the tunnel connector sees a registered connection (`transport/uplink/connector.ts` matches the cloudflared line "Registered tunnel connection") and at server start when the tunnel is already registered. The inbox also tries again on a timer, with a delay that increases from 1 minute to 15 minutes.

### 2.5 Delivery proof (decided; needed because of verification timestamps)

A held request comes to the host late. A verification timestamp check (§3.7) must then compare the sender's timestamp with the time the forwarder received the request, not with the arrival time. If the host trusted a plain `received-at` header, an attacker who captured one signed request could send it again later with an old `received-at`, and pass the timestamp check. So the forwarder must prove its delivery ID and receive time.

- **Forwarder secret.** When a host links, Solus Cloud makes a random secret for that host and gives it to the host in the link answer. The host keeps it in its secret store next to the connector token (`transport/uplink/link.ts`), not in `host-link.json`. Solus Cloud keeps it sealed, and a new link makes a new secret.
- **Proof header.** The forwarder sends `x-solus-hook-delivery-id`, `x-solus-hook-received-at`, and `x-solus-hook-proof`: an HMAC-SHA256, with the forwarder secret, of `hostId.webhookId.deliveryId.receivedAt`. `receivedAt` is epoch milliseconds as decimal text, and the proof is lowercase hex (`packages/contracts/src/webhooks.ts`).
- **Host rules.** The host trusts the delivery ID and the receive time only with a valid proof. Without a valid proof, it treats the request as direct: the receive time is the arrival time, and it ignores the delivery ID. The host clamps a receive time that is later than the arrival time to the arrival time, so a forwarder clock that runs ahead does not fail every timestamp check.
- **Source.** With a valid proof, a request that arrives more than 60 seconds after its receive time is logged as `held`, else as `forwarded`. No other header is needed.
- **Run once.** With a valid proof, the host runs each delivery ID once. It keeps the IDs for 25 hours, longer than the 24-hour hold, in the same dedupe table as the replay keys (§5).

This is a shared secret, not a token signed with a key of our own, so it does not conflict with the `solus-cloud` rule that tokens are signed only through Better Auth's `signJWT`.

### 2.6 Managed hosts (proposed)

A managed host has no tunnel. The forwarder sends to the host's own address in `solus-cloud`, and `host-worker` wakes the host when a request comes (`docs/cloudflare-managed-hosts.md`, `host-worker/README.md`). The companion plan names the address. A wake takes time, so the forwarder waits up to 60 seconds before it holds the request. A started turn keeps the host awake. A host that the user stopped does not wake: the forwarder holds the request, and the request expires after 24 hours.

### 2.7 Organizations (proposed)

- A webhook belongs to one person (`owner_key`) and one organization (`organization_id`), the same as an automation. The access policy treats it as an owned resource (`ownedIdAt('webhook', 0)`).
- Every action runs as that person. The sender is not a person in Solus.
- An action that starts organization work goes through the normal admission (`turn-organization.ts`): on an attached machine the Solus API must accept a new session, and the organization policy applies. For example, with `allowsPersonalHosts: false`, a webhook on a laptop cannot start organization work. The editor checks this when the user saves, and the action checks it again when it runs.
- The URL mode and holding do not change ownership or admission.

**Organization admins (decided: they can see and pause).** An **organization webhook** is a webhook with an organization ID other than `local`. Admins of that organization can see it and pause it on every host. They cannot edit it, delete it, read its token or secret, or read request bodies.

- **What admins see:** the host mirrors the metadata of each organization webhook and a summary of each delivery to the organization's Solus API, through the existing host-to-cloud delivery queue (`sync/delivery-queue.ts`). The metadata is the name, owner, host, project, URL mode, state, and action types. The delivery summary is the time, the outcome, and the action statuses. Never the body, the headers, the token, or the rendered prompts.
- **How a pause works (decided: stop the request before any work starts).** An admin pause is stored in Solus Cloud. Two places enforce it, and neither depends on turn admission:
  1. **The forwarder (immediately).** For a cloud URL, the forwarder answers `409` and does not send the request to the host. When an admin pauses a webhook, the cloud app tells the host's inbox at once, so no cached route lets a request through. Held requests of that webhook are deleted and counted as lost.
  2. **The host (within 5 minutes).** The host already reads its organization facts from Solus Cloud every 5 minutes (`host/organizations.ts`, `GET /v1/hosts/:id/organizations`). That answer also gives the IDs of the webhooks that admins paused. The receiver refuses them after verification (§3.4), and Replay refuses them. This covers a direct URL, a replay from the deliveries log, and a request that was already on its way.
- **Why not turn admission.** Admission does not see every organization turn: on a personal machine, a continuation of an organization session does not call Solus Cloud, and on an attached machine the host acts with a cached delegation token (`turn-organization.ts`, `sync/delegations.ts`). A check at the receiver stops a paused webhook before it starts any work, for every action type.
- **What the owner sees:** when the host learns about the pause (its next read of its organization facts), the webhook shows **Paused by organization admin**. Only an admin can resume it. The owner can still delete it.
- **Access policy:** the `webhookAdminList`, `webhookAdminPause`, and `webhookAdminResume` methods need the organization admin role. They read the Solus API, not a host.

## 3. Webhooks on the host

### 3.1 Actions (decided)

| Action | What it does | Owner it calls |
| --- | --- | --- |
| `start_session` | Starts a new unattended session with the rendered prompt. It uses the action's provider, model, reasoning effort, project folder, and worktree choice. | `prompt-dispatch.ts` `startUnattendedSession` (renamed from `startAutomationSession`; the automation is now an optional `automation` field). `createSession` needs a client and a tab, which a delivery does not have. |
| `send_to_session` | Sends the rendered prompt to one existing session. If the session is busy, the prompt waits in the queue. | `prompt-dispatch.ts` `promptSession(…, 'queue', { actor })` |
| `run_automation` | Starts one run of a saved automation. The rendered template goes into the run's prompt as the webhook context. | `automation-runner.ts` `triggerAutomationRun(automation, { context })`: a new optional argument. The context goes after the automation's prompt, under `[Webhook context]`. |

Later action types (create a task, comment on a task) must fit into the same `WebhookAction` union without a model change.

### 3.2 Fan-out (decided)

A webhook has 1 to 10 actions (decided). Each action has its own template and its own optional filters. Solus runs the actions of one delivery in parallel. One failed action does not stop the others.

**Filters are on actions only (decided).** There is one level of filters. A condition that every action shares goes on each action; the agent writes these copies. Then the answer to "why did this action not run?" is always in that action's own filters, and the log has one result row for each action. Webhook filters can come later without a change to existing webhooks.

- An action without filters runs for every delivery.
- Operators: `equals`, `notEquals`, `in` (a list), and `exists`. Values compare as text. An object or a list passes only `exists`.
- A path uses the template syntax without braces: `headers.x-github-event`, `body.action`, `query.source`. A segment that ends in `[]` tests each item of a list: `body.labels[].name equals agent` matches when one label has that name, and `notEquals` matches when no label has it.
- An action has up to 16 filters, and all must match.

Why 10: a common pattern is one webhook for each repository, with action filters that send each event type to a different action. Each action can start an agent turn, which costs money, so 10 covers that routing pattern and limits the cost of a bad filter. A higher limit is easy to give later; a lower limit breaks users who already go over it.

Example: one GitHub repository webhook (`x-github-event` tells the event type).

| # | Action | Action filters | Template |
| --- | --- | --- | --- |
| 1 | `start_session` (Claude, new worktree) | `headers.x-github-event equals pull_request`, `body.action in opened, reopened` | `Review this pull request: {{body.pull_request.html_url}}` |
| 2 | `send_to_session` (the user's "release" session) | the same as action 1 | `New pull request #{{body.number}}: {{body.pull_request.title}}. Add it to the release notes.` |
| 3 | `run_automation` ("Fix main CI") | `headers.x-github-event equals workflow_run`, `body.workflow_run.conclusion equals failure`, `body.workflow_run.head_branch equals main` | `Failed run: {{body.workflow_run.html_url}}` |
| 4 | `start_session` (Codex) | `headers.x-github-event equals issues`, `body.action equals labeled`, `body.label.name equals agent` | `Investigate this issue and propose a fix: {{body.issue.html_url}}` |

A new pull request runs actions 1 and 2 in parallel. A failed CI run on `main` runs action 3. An issue with the label `agent` runs action 4. The deliveries log shows each action as `started`, `queued`, or `skipped` with the filter that failed.

An automation runs one run at a time (`automation-runner.ts:109`). If a run is active, the action result is `busy`. Solus does not queue it in version 1. The user can replay the delivery.

A `send_to_session` target that is archived or deleted fails only that action. The webhook stays enabled.

### 3.3 Logging and debugging (decided)

Each delivery keeps:

- the receive time, the arrival time, the source (`direct`, `forwarded`, or `held`), the method, the outcome, and the reason when nothing ran;
- the request: redacted headers, redacted query, and the body (1 MiB maximum);
- for each action: the filter results, the rendered prompt, the placeholders with no value, the status (`skipped`, `started`, `queued`, `busy`, `failed`), the error, and a link to the session or automation run it made.

Controls:

- **Deliveries list** for each webhook, newest first, with an outcome filter. It also shows the lost count from the inbox (§2.3).
- **Delivery detail**: the request, and one row for each action with its result and link.
- **Replay**: run a stored delivery again, for all actions or for one action. Replay skips verification and both duplicate checks (§3.4 steps 4, 6, and 7), and the log marks it as a replay. A paused webhook refuses a replay.
- **Dry run**: paste or pick a sample request. Solus shows each filter result and each rendered prompt. It starts nothing and stores nothing.
- **Pause** a webhook, or turn off one action. A paused webhook answers `409`.

Retention: the last 200 deliveries or 14 days for each webhook, whichever is smaller. Deleting a webhook deletes its deliveries.

Each step writes a `dev.log` entry with a stable name and the fields `webhookId`, `deliveryId`, and `sessionId`.

### 3.4 Request handling (proposed)

The receiver accepts `POST`, `PUT`, and `PATCH` on `/hooks/:webhookId/:token` (`transport/http.ts`). Not `GET`: no sender in §3.7 delivers by `GET`, and a `GET` URL with its token lands in more logs. The route must be added to the tunnel path allowlist (`http.ts`, the `offered` test in the tunnel middleware). Every answer has `x-solus-hook-outcome`. The URL token alone is not enough protection (decided), because a URL can leak into a proxy log, a screenshot, or a sender dashboard. A request must also pass verification (§3.7). The order of checks:

1. Body over 1 MiB → `413`.
2. Unknown webhook or wrong token → `404`. The server compares the token in constant time. A wrong token and an unknown webhook get the same answer.
3. More than 60 deliveries in one minute → `429`. This is before verification on purpose: an unsigned flood must not cost one signature check for each request.
4. Verification fails → `401`. The deliveries log stores the step that failed (§3.7).
5. An unverified organization webhook whose organization does not allow it (§3.7) → `403`, outcome `not_allowed`. Paused by the owner or by an organization admin (§2.7) → `409`. This is after verification so that a sender without the secret cannot learn from the status code that the token is valid.
6. A delivery ID with a valid proof (§2.5), seen in the last 25 hours → `202`, logged as `duplicate`.
7. Replay key seen in the last 7 days → `202`, logged as `duplicate`. This also applies to a delivery that was `filtered` the first time: a sender's redelivery after the user edits a filter is a duplicate, and the user replays it from the log instead.
8. Otherwise → `202` with the `deliveryId`. Solus tests the filters of each action and runs the actions that match, after the answer. The sender does not wait for an agent. If no action matches, the delivery is logged as `filtered`, and each action row shows the filter that failed.

A delivery with a valid proof (§2.5) counts toward the limit in step 3 like any other. The forwarder drains an inbox one request at a time and treats `429` as "try later" (§2.3), so a large inbox arrives over several minutes.

### 3.5 Prompt safety (proposed: port from T3 Code without change)

Request data is untrusted. Any GitHub user can write text into a GitHub payload, also when the request passes verification. Verification proves who sent the request, not that its text is safe.

- Each value goes into the prompt inside `<webhook-data-…>` tags, with a random tag for each delivery.
- Inside a value, an invisible character goes after `$`, other currency signs, `@`, and a lone `/word`. Then `$skill`, `@file`, and `/command` in request text do not act.
- `{{request}}` and the stored log hide headers and query values whose names look like credentials.
- The UI and the tool description say this: the tags help the agent, but they do not guarantee that the agent ignores the text.

### 3.6 Agent access (decided)

New agent tools in the Solus toolbox (`execution/agents/tools/`), for Claude and Codex:

| Tool | `requiresApproval` |
| --- | --- |
| `create_webhook`, `update_webhook`, `delete_webhook`, `rotate_webhook` | yes |
| `list_webhooks`, `read_webhook_delivery`, `dry_run_webhook` | no |
| `request_secret` | no (the user answers the card) |

**No sender presets (decided).** Solus has no catalog of senders. The agent knows how a sender such as GitHub, Linear, or Sentry signs its requests, its event names, and its payload shape. It writes the verification settings, filters, and templates itself. The editor UI has plain fields with no defaults. Before the agent asks for approval, it can call `dry_run_webhook` with a sample payload that it writes, to test its filters and templates.

Verification uses only the generic schemes in §3.7. No scheme or setting names a sender.

Approval uses the existing permission card, the same as `create_automation`. The result of `create_webhook` gives the URL and its mode. When the host has no URL, the tool tells the agent to ask the user to link the host or to set its public URL.

`request_secret` shows a private card in the session. The user types the value, or declines. The server keeps the value and gives the agent a `secretRef`. The `secretRef` works once, only for the session that asked, and ends after 15 minutes. `create_webhook` and `update_webhook` accept `verification.secretRef` in place of a secret. The secret never appears in tool input, tool output, or the transcript. This uses the input-request flow (`execution/sessions/input-requests.ts`), as the MCP elicitation does (`integrations/gateway.ts`). Other tools can accept a `secretRef` later.

### 3.7 Verification (decided: required by default, generic, no sender names)

The URL token alone is not enough. The sender chooses how it signs a request, so the receiver supports the common patterns with generic schemes.

**Required by default, with a narrow opt-out (decided).** A new webhook must have a verification scheme. The opt-out is valid only for a sender that can neither sign its requests nor send a custom header, so its settings accept a URL and nothing else. If a sender can send one header, the `token` scheme applies. Testing, a LAN-only host, a direct URL, or a hard setup are not valid reasons.

- **A reason is required.** To opt out, the user or the agent chooses "This sender accepts only a URL", and names the sender and why it cannot sign or send a header. The webhook stores the reason. The approval card and the editor show it with this text: "No verification. Anyone with this URL can start agent work."
- **Organization policy.** A new organization policy, `allowsUnverifiedWebhooks`, is off by default. When it is off, an unverified webhook cannot start organization work: the editor refuses the save, and the receiver refuses the request (the host reads the policy with its other organization facts). The policy applies only to a webhook whose `organization_id` is that organization. A `local` webhook on a machine attached for organization work is personal and is not affected. Organization admins change the policy in the organization settings, next to `allowsPersonalHosts`.
- **Visible.** The Settings table and the admin view mark every unverified webhook and show its reason.

Every scheme uses the same building blocks:

- **Value source**: a header, or one part of a header in the form `key=value` with a chosen separator (`,` or `;`). Example: the part `t` of a header that holds `t=…,v1=…`.
- **Signed text**: a template, for example `{{body}}`, or `{{headers.x-request-timestamp}}:{{body}}`, or `{{headers.x-sig|t}}.{{body}}`. `{{body}}` is the raw body bytes.
- **Signature format**: an encoding (`hex` or `base64`), an optional prefix, and an optional list form when one header holds several signatures (the check passes if one matches).
- **Timestamp check** (optional): a value source for the timestamp and a tolerance in seconds. An old request fails. This stops replays.

| Scheme | Check | Settings |
| --- | --- | --- |
| `hmac` | HMAC of the signed text with a shared secret | Algorithm (`sha256`, `sha1`, `sha512`), secret, signed text, signature source and format, optional timestamp check |
| `public_key` | Signature of the signed text with the sender's public key | Algorithm (`ed25519`, `ecdsa-p256`), public key, signed text, signature source and format, optional timestamp check |
| `token` | A value in the request equals a shared secret | Value source (a header, a header part, or the bearer token of `Authorization`), secret |
| `jwt` | A signed token in the request | Value source, issuer, audience, JWKS URL. The host keeps the keys in a cache, as `admission/access-tokens.ts` does. |
| `standard_webhooks` | The open Standard Webhooks specification | Secret |

These schemes cover most senders without sender code. Examples, for the tool description only: GitHub, Linear, Sentry, Shopify, Slack, Stripe, Paddle (`hmac`); Discord, SendGrid (`public_key`); GitLab, Telegram (`token`); Google Pub/Sub (`jwt`); Svix-based senders (`standard_webhooks`).

The secrets of `hmac`, `token`, and `standard_webhooks` go into the secret store with the URL token. A secret that a sender gives in base64 is decoded before it is saved; `standard_webhooks` decodes its own `whsec_` secret. A public key, an issuer, an audience, and a JWKS URL are not secret and are stored on the record.

Verification runs on the host, also for held requests: the forwarder keeps the raw body bytes and headers, so a late check gives the same result. A timestamp check on a held request uses the forwarder's receive time, only when the delivery proof is valid (§2.5).

**Debugging.** When verification fails, the deliveries log stores the step that failed, never a secret or a computed signature: `value_missing` (with the source name), `timestamp_outside_tolerance`, `signature_mismatch`, `jwt_invalid` (with the claim that failed), or `keys_unavailable`. Replay skips verification. Dry run checks verification when the user pastes a real signed request.

## 4. User interface (decided: Settings and project panel)

Desktop and web (shared Svelte UI):

- **Settings → Webhooks** (decided: one table for all hosts):
  - The client reads `webhookList` from every connected host and joins the results into one table. Columns: name, host, project, URL mode and reachability, state (active, paused, paused by organization admin), actions, last delivery with its outcome, deliveries in the last 24 hours, and owner.
  - Filters: host, project, state, last outcome (for example "failing"), URL mode, owner, and organization. A text search matches the name and the project. The filters are kept in the URL of the page, so a link opens the same view.
  - A host that is not connected shows one row: "<host> is not connected. Its webhooks are not shown." The table never shows old rows as current.
  - A row opens the editor, the URL with Copy and Rotate, the deliveries, and the dry run.
  - Organization admins get a second view, **Organization**, that reads the Solus API (§2.7). It shows the organization webhooks of all members, with Pause and Resume.
- **Project panel → Webhooks**: the webhooks of this project, with state and last delivery. A row opens the webhook in Settings.
- **Host settings**: **Hold webhooks while offline** (linked hosts) and **Public URL** (all hosts).
- **Command palette**: "New webhook" and "Open webhooks".
- **Unlink confirmation**: the warning from §2.2.

The editor shows reachability honestly:

| State | Text |
| --- | --- |
| Linked, holding on | "Requests wait in Solus Cloud for up to 24 hours while this host is offline." |
| Linked, holding off | "Requests fail while this host is offline." |
| Personal host, holding off | "Requests fail while this computer sleeps. Turn on holding, or use a cloud machine." |
| Direct URL | "Solus cannot hold requests for this host. Keep it reachable at its public URL." |
| No URL | "Link this host to Solus Cloud, or set its public URL." |

Mobile (`apps/mobile/`): a Webhooks screen in host settings. This is a new React Native surface, because mobile has no automation screens today. Version 1 has what a person does from a phone: the list, the deliveries, pause and resume, replay, Copy, and the two host settings. The editor, secret entry, Rotate, and dry run come in a later step (§8, question 2).

## 5. Contract and storage

Solus:

- Types in a new `packages/contracts/src/webhooks.ts`: `Webhook`, `WebhookAction`, `WebhookFilter`, `WebhookVerification`, `WebhookUrl` (`{ mode: 'cloud' | 'direct' | 'none', path, url }`), `WebhookDelivery`, `WebhookActionResult`. A list read never gives the token: `Webhook` has only `urlMode`, and `WebhookWithUrl` adds `url`. Create, Rotate, and `webhookRead` (for the owner) give it; Copy is a client action on that value, not a method.
- RPC methods: `webhookList`, `webhookRead`, `webhookCreate`, `webhookUpdate` (pause is the `enabled` field of the record, so there is no separate method), `webhookDelete`, `webhookRotate`, `webhookListDeliveries`, `webhookReadDelivery`, `webhookReplay`, `webhookDryRun`, `secretRequestAnswer`, `hostWebhookSettingsRead`, `hostWebhookSettingsUpdate`, and the admin methods `webhookAdminList`, `webhookAdminPause`, `webhookAdminResume` (Solus API). Each needs `rpc.ts`, `host-api.ts`, `permissions.ts`, `rpc-planes.ts`, and an access-policy entry.
- Event topics: `webhook.changed` and `webhook.delivery` (a short summary only, never the body).
- Uplink contract (`packages/contracts/src/uplink.ts`, copied to `solus-cloud` by `contracts:sync`): `allowsUnverifiedWebhooks` on `organizationPolicySchema`, the forwarder secret in the link answer, the hold setting on the link, the drain request, and the drain answer with the lost count for each webhook ID. As built, matched with `solus-cloud`: `allowsUnverifiedWebhooks` on each policy (optional in the schema, so older control planes stay valid; absent means off); `pausedWebhookIds` at the top level of the organizations answer; `forwarderSecret` (`hfs_` and 52 base32 characters, and the HMAC key is its UTF-8 bytes) on the `POST` link answer and, while linked, on the `GET` boot check, which also gives `holdWebhooks` (a managed host gets its secret only from the boot check); `PUT /v1/hosts/:id/link/hooks` takes and answers `{ holdWebhooks }`, or `409 host_not_linked`; `POST /v1/hosts/:id/hooks/drain` takes `{}` and answers `{ lost: { <webhookId>: count } }`, or `503 hook_inbox_unavailable` with `retry-after` (ask again), or `404` from a control plane without the forwarder. The host shows a cloud URL only when it holds a forwarder secret. The receiver accepts webhook IDs of `[A-Za-z0-9._~-]{1,128}` and tokens of `[A-Za-z0-9._~-]{1,256}`.
- Tables (drizzle, SQLite and Postgres): `webhooks`, `webhook_deliveries`, and `webhook_seen_keys` (one table for the replay keys and the proven delivery IDs: `kind`, `key`, `expires_at`, with one sweeper). The host public URL is a new field of the host settings record (`host/`). The token and the verification secret go into the secret store (`platform/secrets.ts`), not into a table.
- Server code: data in `packages/server/src/data/webhooks/`, the receiver and the action runner in `packages/server/src/execution/webhooks/`, the RPC handler in `transport/handlers/webhook-handlers.ts`, and the drain call in `transport/uplink/`.

Solus Cloud: see the companion plan.

## 6. Steps and release order

Solus ships first, because `solus-cloud` copies the uplink contract and pins a Solus commit.

1. **Solus: receiver and store.** Contract, tables, store, and the receiver (§3.4, §3.5) with focused tests: token, each verification scheme and its failure steps, filters, delivery ID, replay key, templates, redaction, and the `x-solus-hook-outcome` header.
2. **Solus: actions and the log.** The three actions and the delivery log. Tests for fan-out, partial failure, `busy`, and lost access.
3. **Solus: RPC and desktop/web UI.** Settings, project panel, host settings, command palette, unlink warning.
4. **Solus: agent tools and `request_secret`**, for Claude and Codex.
5. **Solus: drain call and uplink contract.** The host asks for a drain when its tunnel registers and at start, and it shows the lost count.
6. **Solus Cloud: forwarder and inbox.** The companion plan, after the Solus commit is pinned.
7. **Solus: mobile screens** (the version 1 set in §4).
8. **Docs:** user doc `docs/webhooks.md`, with a GitHub setup example and the reachability table.
9. **Later:** the mobile editor, and "Copy filters from another action" in the editor if users ask for it.

Until step 6 ships, a linked host shows the direct URL if its public URL is set, or the path only.

## 7. Not in version 1

- A maximum delivery age.
- Webhook filters (one filter list that applies to every action). They can come later if repeated action filters become a problem.
- Coalesce windows.
- Moving a webhook to another host and keeping its URL.
- Webhooks owned by an organization rather than a person.
- An organization policy that forces holding off.
- Action types other than the three in §3.1.
- A `startsWith` filter operator, and an OR between filters.
- Verification that downloads a certificate named in the request (AWS SNS, PayPal).
- Answers to sender setup handshakes (for example a challenge that the receiver must echo).
- `GET` deliveries.

## 8. Open questions

The sections marked "proposed" need sign-off: §2.1, §2.4, §2.6, §2.7 (the ownership and admission part), §3.4, and §3.5. In addition:

1. `start_session` through `startAutomationSession` (§3.1): rename it to a generic unattended start, or add a webhook variant? **Answered:** renamed to `startUnattendedSession`.
2. Mobile version 1 without the editor (§4): is "list, deliveries, pause, replay, Copy, host settings" the right set for a phone? **Answered:** yes.
3. The `run_automation` context argument (§3.1): a new optional argument on `triggerAutomationRun`, or no template for that action type? **Answered:** the optional argument.
