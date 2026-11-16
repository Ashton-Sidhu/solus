# Config

Config is the settings of an app that its user changes without a new version: a headline, a page size, the hour of a digest, a team to follow, a feature that is on or off. The user changes a value on the app's Manage page, under Config. The backend and the UI read it. The starter's `headline` and `pageSize` are examples.

```ts
config: {
  team: { type: 'text', label: 'Team', description: 'The Linear team whose issues the app shows.', default: 'ENG' },
  digestHour: { type: 'number', label: 'Digest hour', description: 'The hour of the morning digest.', default: 9, min: 0, max: 23, integer: true },
  includeDone: { type: 'boolean', label: 'Show finished issues', default: false },
  sort: { type: 'choice', label: 'Sort', default: 'updated', options: [{ value: 'updated', label: 'Last updated' }, { value: 'priority', label: 'Priority' }] },
},
```

| Type | Takes | Options |
|---|---|---|
| `text` | a string of at most 2000 characters | `multiline: true` for a text area |
| `number` | a number | `min`, `max`, `integer: true` |
| `boolean` | on or off | |
| `choice` | one of `options` | `options: [{ value, label }]` |
| `model` | a model id; empty is Solus's default | `ctx.models` names it ([models](models.md)) |

- Each field has a `label`, an optional one-sentence `description`, and a `default`. The default is the value until the user sets one, and in every preview. A default that the field does not take fails the deploy.
- The backend reads `ctx.config.<name>` in an operation and `step.config.<name>` in a workflow step. A value is a `string`, a `number`, or a `boolean`: convert it where a type matters (`Number(ctx.config.pageSize)`).
- The UI reads `api.useConfig()` from `appClient<typeof app>()`. It is typed from `app.ts`, and it reads again when the user changes a value. Keep the layout steady while it loads (the starter keeps the headline's height).
- A change applies at once: the backend runs with the new value from its next call, and every open UI reads the config and its queries again. A schedule reads the value when it runs.
- When a new version changes a field, a value the user set that the new field does not take is not used: the field has its default again.

## Config, secrets, or storage

- **Config**: a setting the user chooses, that is safe to show, and that the backend or the UI reads. The user changes it on the Manage page.
- **Secrets** ([access](access.md)): a value that must not be shown, such as an API key. Only the backend reads it.
- **Storage** or the **database** ([data](data.md)): what the app's own UI changes as part of its work, such as a filter or a row. Do not use config for that: a change in the UI must not need the Manage page.

Do not build a settings page in the app for what config holds: the Manage page is that page. An agent sees the values with `inspect_app`, but only the user changes them.
