# Schedules, webhooks, and signals

## Schedules

```ts
schedules: {
  digest: { cron: '0 9 * * 1-5', timezone: 'America/Toronto', run: 'sendDigest' },
  sync: { every: { minutes: 30 }, run: 'sync', input: { full: false } },
},
```

A schedule runs one mutation of the app with the `input` you give. It is on from the deploy that declares it; the user can pause it on the Manage page. It runs as the app's owner, with `ctx.caller.kind === 'schedule'`. A run that fails is in the app's call log and does not retry: when the work must not be lost, let the mutation start a [workflow](workflows.md). On a desktop host a schedule fires only while Solus is open; say so when the user expects it to run at night.

App schedules are the app's own. Do not make an automation for them.

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

A deploy makes a webhook for each declaration. Solus checks the signature before the mutation runs, drops a second delivery with the same `replayKey`, and keeps a log of deliveries. The mutation gets `{ headers, query, body }`: header names are lower case, and `body` is JSON when the request was JSON. Answer fast: store the event, or start a workflow, and return.

The app's Manage page shows each webhook's URL and its signing secret. Tell the user to copy both into the other service. When the other service gives its own secret, the user sets it in Settings → Webhooks. The verification schemes are the ones of `create_webhook`: `hmac`, `public_key`, `token`, `jwt`, `standard_webhooks`, and `none` with a reason.

## Signals

A signal is how the app says that something happened: to the user, and to their agents.

```ts
import { signal } from '@solus/app/backend'

signals: {
  'invoice.overdue': signal({ description: 'An invoice is past its due date.', payload: z.object({ id: z.string(), customer: z.string(), days: z.number() }) }),
},
// in a mutation, or in a step of a workflow (step.signals.emit):
ctx.signals.emit('invoice.overdue', { id, customer, days })
```

- A name is lower-case words with dots. The payload is JSON of at most 64 KiB that the schema accepts. Send a summary and an id, not the whole record.
- A signal is kept only when its call or its step succeeds. One call emits at most 100.
- A signal does nothing by itself. The user decides on the Manage page what each one does: a notification, a prompt to a session, or a run of an automation. A new signal gets a notification, turned on.
- When the user asked for the agent to act on a signal, set that up with `set_app_signal_action` after the deploy, and say what you set. It needs approval.
- Emit for what a person wants to hear of, not for each row: a signal can start agent work, and that costs money.
