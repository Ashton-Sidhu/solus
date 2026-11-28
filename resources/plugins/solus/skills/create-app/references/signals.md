# Signals and actions

A signal reports a fact that has already happened, such as `report.ready`. The app declares and emits the fact. The app owner chooses who hears about it and what they do. Use a [webhook](triggers.md#webhooks) when the event comes into the app from another service. Use a [workflow](workflows.md) when the app itself must finish a job across failures or restarts.

## Declare and emit

Add a named declaration to `defineApp({ signals: { ... } })`. Give it a description that says when it fires and a Zod schema for its JSON payload. Use a stable dotted name such as `report.ready`. Names are at most 64 characters, with lower-case letters, digits, and underscores in each segment. Each segment starts with a letter.

Include the ID that lets an agent look up the result and a short summary that a person can read. Keep secrets and unnecessary personal data out of the payload. An occurrence is in the app's history and its fields can be included in notifications and agent prompts.

This app uses the report ID to prevent duplicate emissions when a caller submits the same report again. It saves the report before it emits. An agent can read the saved report by ID.

```sql
-- migrations/0001_reports.sql
CREATE TABLE reports (
  id TEXT PRIMARY KEY NOT NULL,
  summary TEXT NOT NULL
);
```

```ts
import { defineApp, mutation, query, signal } from '@solus/app/backend'
import { z } from 'zod'

const ReportId = z.object({ id: z.string().min(1).max(128) })
const Report = ReportId.extend({ summary: z.string().min(1).max(500) })

export default defineApp({
  name: 'Reports',
  ui: false,
  instructions: 'Use getReport with the ID from a report.ready signal.',
  signals: {
    'report.ready': signal({
      description: 'A report has been saved and is ready to read.',
      payload: Report,
    }),
  },
  operations: {
    recordReport: mutation(
      {
        description: 'Save a new report and emit a signal if it was inserted.',
        input: Report,
        output: z.object({ saved: z.boolean() }),
      },
      (ctx, report) => {
        const saved = ctx.sql.exec<z.infer<typeof Report>>(
          'INSERT INTO reports (id, summary) VALUES (?, ?) ON CONFLICT(id) DO NOTHING RETURNING id, summary',
          report.id, report.summary,
        ).one()
        if (saved) ctx.signals.emit('report.ready', saved)
        return { saved: saved !== null }
      },
    ),
    getReport: query(
      { description: 'Read a saved report by ID.', input: ReportId, output: Report.nullable() },
      (ctx, { id }) => ctx.sql.exec<z.infer<typeof Report>>(
        'SELECT id, summary FROM reports WHERE id = ?',
        id,
      ).one(),
    ),
  },
})
```

- Use `ctx.signals.emit(name, payload)` in a mutation or `step.signals.emit(name, payload)` inside a workflow's `step.do` callback. A workflow can also call a mutation that emits. Pick one place to report completion.
- Solus validates the payload and keeps emissions from a successful call or step. Emit after the result is saved or ready to read. A write can commit even if the call later fails before Solus records the signal.
- A payload is at most 64 KiB and a call can emit up to 100 signals. Report a useful state change or one batch result. For a check that repeats, record what has already been reported or when a condition changes. Repeating an ordinary mutation can otherwise emit a new occurrence. Workflow step emissions have stable occurrence IDs when that step replays.

## Route a signal

In **Manage → Signals**, the owner can see each signal and enable or disable its actions. A new signal gets an enabled notification for the owner. To hand work to an agent, add an action only when that handoff is part of the requested task.

- **Notify** for a result a person should see. Give the notification a short title.
- **Send to session** for follow-up in an existing agent session. Choose the target session and write the task in the template. For example, use `Read report {{payload.id}} with the app's getReport operation. Summarize the result.`
- **Run automation** when an existing automation should handle the event. Choose it and pass the relevant ID or summary as its context.

After deploy, use `inspect_app` with `view: "signals"` to find the signal and its actions. The `set_app_signal_action` tool takes the app slug, signal name, and type. Use `session_id` for `send_to_session` and `automation_id` for `run_automation`. Supply an existing `action_id` to update an action. The tool requires approval.

A template can use `{{app}}`, `{{signal}}`, `{{payload}}`, or a specific field such as `{{payload.id}}`. Keep the task in the template and the event data in the payload. Solus marks payload values as data in agent prompts. Prefer named fields to forwarding a whole provider event.

## Verify delivery

1. Run the emitting operation with an authorized test input on the active app. Check its saved result or workflow step.
2. In **Manage → Signals** or `inspect_app` with `view: "signals"`, look for the occurrence and its action outcomes. If an occurrence is absent, check the originating call or workflow step. If no action ran, check whether an action is enabled for that signal.
3. Check the intended notification, session, or automation run. Delivery is asynchronous, and a delivered agent action means the handoff was accepted. Check the destination to see whether the work finished.

Solus records failed and throttled actions. A busy automation can fail delivery, and an agent action is limited to 30 starts per hour. A signal action is not a durable job queue. Use a workflow for work that must finish even if a notification or handoff fails.

## Change a deployed signal

Keep its name and fields used by existing templates. Add fields without changing the meaning of existing ones. Removing or renaming a signal removes its action settings on deploy. For a breaking change, plan the cutover, update the actions for the new signal, and verify delivery before you remove the old declaration. Avoid emitting both versions to the same destination for one event.
