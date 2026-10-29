# Webhooks

A webhook lets another service start agent work on a host. The service sends a
request to the webhook's secret URL. Solus checks the request, then runs the
webhook's actions: start a session, send a prompt to a session, or run an
automation. The design is in `docs/plans/webhooks.md`.

## Where webhooks live

A webhook is a record on the host that runs its work. The host keeps the URL
token, the verification secret, the deliveries log, and the actions. Solus
Cloud never sees a secret and never runs an action.

You manage webhooks in these places:

- **Settings → Webhooks**: one table for all connected hosts. Filter by host,
  project, state, last outcome, URL mode, owner, and organization. The filters
  are in the page URL, so a link opens the same view.
- **Project panel → Webhooks**: the webhooks of the project.
- **Command palette**: "New webhook" and "Open webhooks".
- **Mobile**: host settings → Webhooks. On a phone you can see the list and the
  deliveries, pause and resume, replay, copy the URL, and change the two host
  settings. To edit a webhook, use desktop or web.
- **An agent**: ask it. The agent tools are `create_webhook`,
  `update_webhook`, `delete_webhook`, `rotate_webhook`, `list_webhooks`,
  `read_webhook_delivery`, `dry_run_webhook`, and `request_secret`. A change
  asks for your approval first.

## The URL

The URL a webhook gives depends on the host:

| Host | URL |
| --- | --- |
| Linked to Solus Cloud | `https://app.solus.sh/hooks/<hostId>/<webhookId>?t=<token>` (the Cloud URL; on the Solus Cloud address the host is registered with) |
| Not linked, with a public URL | `<public URL>/hooks/<webhookId>/<token>` (the Direct URL) |
| Not linked, no public URL | No URL. Link the host to Solus Cloud, or set its public URL. |

Set the public URL in host settings: **Public URL**. Use the address where you
expose the host, for example a reverse proxy or an ngrok address.

The Cloud URL has the token in its query (`?t=`), so the Solus Cloud logs redact it. The Direct URL has it in the path.

The token in the URL is a credential. A list never shows it. Only the owner
can read and copy the URL. **Rotate** makes a new token; the old URL stops
working at once.

When a host unlinks from Solus Cloud, its Cloud URLs stop working. The unlink
confirmation tells you how many webhooks use the cloud URL. The editor marks a
URL that changed since you last copied it, also when the form or the address of the Cloud URL changed (a Cloud URL copied in an earlier form is marked). Give the sender the new URL.

## Reachability

| State | What happens |
| --- | --- |
| Linked, holding on | Requests wait in Solus Cloud for up to 24 hours while this host is offline. |
| Linked, holding off | Requests fail while this host is offline. |
| Personal host, holding off | Requests fail while this computer sleeps. Turn on holding, or use a cloud machine. |
| Direct URL | Solus cannot hold requests for this host. Keep it reachable at its public URL. |
| No URL | Link this host to Solus Cloud, or set its public URL. |

**Hold webhooks while offline** is in host settings for a linked host. It is on
by default. Solus Cloud holds at most 1,000 requests for each host, each up to
1 MiB, for 24 hours. A held request gets the answer `202 {"held": true}`; the
real result is in the deliveries log. When the host comes back, it asks Solus
Cloud for the held requests. Requests that Solus Cloud dropped show in the
log: "3 requests were lost while this host was offline (not verified)."

## Verification

The URL token alone is not enough: a URL can leak into a log or a screenshot.
A new webhook must have a verification scheme. Choose the scheme your sender
uses:

| Scheme | Check | Example senders |
| --- | --- | --- |
| `hmac` | An HMAC of the signed text with a shared secret | GitHub, Linear, Sentry, Shopify, Slack, Stripe, Paddle |
| `public_key` | An Ed25519 or ECDSA P-256 signature with the sender's public key | Discord, SendGrid |
| `token` | A header, a header part, or the bearer token equals a shared secret | GitLab, Telegram |
| `jwt` | A signed token with an issuer, an audience, and a JWKS URL | Google Pub/Sub |
| `standard_webhooks` | The Standard Webhooks specification | Svix-based senders |

The signed text is a template: `{{body}}` is the raw body,
`{{headers.name}}` is a header, and `{{headers.name|key}}` is one `key=value`
part of a header. A timestamp check refuses an old request.

Use scheme `none` only when the sender accepts a URL and nothing else: it
cannot sign its requests and cannot send a header. Give the reason. Settings
marks the webhook: "No verification. Anyone with this URL can start agent
work." An organization must allow unverified webhooks
(`allowsUnverifiedWebhooks`) before an unverified webhook can start its work.

When verification fails, the deliveries log shows the step that failed:
`value_missing`, `timestamp_outside_tolerance`, `signature_mismatch`,
`jwt_invalid`, `keys_unavailable`, or `secret_missing`. It never shows a secret
or a signature.

## Actions and filters

A webhook has 1 to 10 actions. Each action has its own filters and its own
template, and the actions of one delivery run at the same time.

- `start_session`: starts a new unattended session with the rendered prompt,
  on the agent, model, reasoning level, folder, and worktree choice you set.
- `send_to_session`: sends the rendered prompt to one session. A busy session
  queues it. An archived or deleted session fails only this action.
- `run_automation`: starts one run of a saved automation. The rendered
  template goes into the run's prompt as webhook context. If the automation
  already runs, the result is `busy`; replay the delivery later.

A filter tests the request: `headers.x-github-event equals pull_request`.
Operators are `equals`, `notEquals`, `in`, and `exists`. Values compare as text.
A path segment that ends in `[]` tests each item of a list:
`body.labels[].name equals agent` matches when one label has that name. An
action runs only when all its filters match. An action without filters runs
for every delivery.

Templates use `{{body.path}}`, `{{headers.name}}`, `{{query.name}}`,
`{{body}}`, and `{{request}}`. A **replay key**, for example
`{{headers.x-github-delivery}}`, makes a second delivery with the same key a
duplicate for 7 days.

Request data is untrusted. Each value goes into the prompt inside a random
`<webhook-data-…>` tag, and `$skill`, `@file`, and `/command` in request text
are made inert. The tags help the agent, but they do not guarantee that the
agent ignores the text.

## Deliveries

The deliveries log keeps the last 200 deliveries or 14 days for each webhook,
whichever is smaller. Each delivery shows the receive time, the source
(`direct`, `forwarded`, or `held`), the request with credential-like headers
and query values hidden, and one row for each action: its filter results, the
rendered prompt, the status, the error, and a link to the session or run.

- **Replay** runs a stored delivery again, for all actions or for one. It
  skips verification and the duplicate checks. A paused webhook refuses it.
- **Dry run** tests a sample request. It shows each filter result and each
  rendered prompt, and it starts nothing.
- **Pause** stops the webhook: it answers `409`. An organization admin can also
  pause an organization webhook; only an admin resumes it.

## Answers

Every answer has the header `x-solus-hook-outcome`.

| Status | Outcome | Why |
| --- | --- | --- |
| `202` | `accepted` | The actions run after the answer. The body has the `deliveryId`. |
| `202` | `duplicate` | The delivery ID or the replay key came before. |
| `401` | `unverified` | Verification failed. |
| `403` | `not_allowed` | The organization does not allow unverified webhooks. |
| `404` | `not_found` | Unknown webhook or wrong token. |
| `405` | `method_not_allowed` | Use `POST`, `PUT`, or `PATCH`. |
| `409` | `paused` | The webhook is paused. |
| `413` | `too_large` | The body is larger than 1 MiB. |
| `429` | `rate_limited` | More than 60 deliveries in one minute. |

## Example: GitHub pull requests

1. Ask an agent: "Make a webhook for acme/api that reviews new pull requests."
2. The agent calls `request_secret`. A private card asks you for a secret.
   Type a long random value and keep a copy for GitHub. The agent never sees it.
3. The agent tests its filters with `dry_run_webhook`, then asks your approval
   for `create_webhook` with these settings:
   - Verification: `hmac`, `sha256`, signed text `{{body}}`, signature from the
     header `x-hub-signature-256`, `hex`, prefix `sha256=`.
   - Replay key: `{{headers.x-github-delivery}}`.
   - Action `start_session`, filters `headers.x-github-event equals
     pull_request` and `body.action in opened, reopened`, template
     `Review this pull request: {{body.pull_request.html_url}}`.
4. Copy the URL from the result or from Settings → Webhooks.
5. In GitHub, open the repository → Settings → Webhooks → Add webhook. Paste
   the URL, set the content type to `application/json`, paste the same secret,
   and choose "Pull requests".
6. GitHub sends a ping. It has no `pull_request` event, so the log shows it as
   `filtered`. Open a pull request: the log shows the action as `started` with
   a link to the new session.
