# Schedules, webhooks, and signals

## Choose a trigger

- **On demand.** Use an operation when someone opens a view, clicks a button, or asks an agent to do the work.
- **Schedule.** Use an interval for periodic checks and cron with a time zone for a calendar time, such as a weekday digest. Use polling when the service cannot send the event you need. Check that the app's host will be available at run time.
- **Webhook.** Use a webhook when a service can send a specific event, such as a closed issue or completed deploy, to a reachable callback URL. Verify the delivery, do the minimum work needed to accept it, and reply quickly. If missing an event would leave the app's data incorrect, add a periodic check when the service can list what changed.
- **Workflow.** Start one from the operation that accepts the request if the work needs retries, waits, or progress across a restart. A button, schedule, or webhook can all start the same job. See [Workflows](workflows.md).
- **Signal.** Emit a [signal](signals.md) when the app has a result or change to report. Use it for an outbound notification or agent handoff.

For unattended work, check which [app connection](access.md#integrations) provides service access and how the user can see or stop the work. If the task only asks for on-demand behavior, leave it on demand.

## Schedules

```ts
schedules: {
  digest: { cron: '0 9 * * 1-5', timezone: 'America/Toronto', run: 'sendDigest' },
  sync: { every: { minutes: 30 }, run: 'sync', input: { full: false } },
},
```

A schedule runs one mutation of the app with the `input` you give. It is on from the deploy that declares it; the user can pause it on the Manage page. It runs as the app's owner, with `ctx.caller.kind === 'schedule'`. A run that fails is in the app's call log and does not retry: when the work must not be lost, let the mutation start a [workflow](workflows.md). On a desktop host a schedule fires only while Solus is open; say so when the user expects it to run at night.

App schedules are the app's own. Do not make an automation for them.

- Keep the declaration name stable. A redeploy keeps the pause setting and run history for the same name. A new name creates a new schedule and turns it on.
- One mutation at a time runs for each schedule. After host downtime, an overdue schedule runs once. If it must process every missed interval, keep the last processed time in app data and read the missing range from that point.
- In Manage, check the next run time and use **Run now** for an authorized test. It uses the scheduled caller and leaves the next automatic run time in place. Check the call log for the mutation's outcome. If it started a workflow, check the workflow run as well.

## Webhooks

```ts
import { webhookRequest } from '@solus/app/backend'

operations: {
  onIssue: mutation({ description: 'Save an issue GitHub sent.', input: webhookRequest }, (ctx, request) => {
    if (request.headers['x-github-event'] !== 'issues') return null
    // request.body is the JSON GitHub sent
  }),
},
webhooks: {
  issues: {
    verify: {
      scheme: 'hmac', algorithm: 'sha256', signedText: '{{body}}',
      signature: { source: { kind: 'header', name: 'x-hub-signature-256' }, format: { encoding: 'hex', prefix: 'sha256=' } },
    },
    replayKey: '{{headers.x-github-delivery}}',
    run: 'onIssue',
  },
},
```

A deploy makes a webhook for each declaration. Solus checks the signature before the mutation runs, drops a second delivery with the same `replayKey`, and keeps a log of deliveries. Use the provider's stable delivery ID for the key. The mutation gets `{ headers, query, body }`: header names are lower case, and `body` is JSON when the request was JSON. Validate the event type and the fields you use. Store the event or start a workflow and return.

The app's Manage page shows each webhook's URL and its signing secret. Tell the user to copy both into the other service. When the other service gives its own secret, the user sets it in Settings → Webhooks. The verification schemes are the ones of `manage_webhooks`: `hmac`, `public_key`, `token`, `jwt`, `standard_webhooks`, and `none` with a reason.

- Subscribe only to the provider events the app handles. Check that the provider can reach the displayed callback URL. On a local host with no public URL, Manage shows no URL until the user links the host to Solus Cloud or sets a public URL in host settings. Store the signing secret in the provider's and Solus's setup fields. Keep it out of source and call logs.
- Use the provider's test delivery or an authorized fixture to verify signature handling and the handler result. In the webhook delivery log, check that a valid request reached the mutation and that a repeated delivery ID started no second action. Check the app's call log and, if the handler starts a workflow, the run result.
- A dry run with `read_webhooks` can check a saved webhook's verification or action matching. Check the real delivery separately to verify reachability and execution.

## Signals

See [Signals](signals.md) for payloads, signal actions, delivery checks, and safe changes to deployed signals.
