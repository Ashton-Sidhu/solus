# App files

The user gives the app a file in the UI, and the backend reads it:

```tsx
import { files } from '@solus/app'

<input type="file" accept=".csv" onChange={async (event) => {
  const picked = event.target.files?.[0]
  if (!picked) return
  const file = await files.upload(picked, picked.name, setProgress)   // { id, name, type, size }
  await api.mutate('importCsv', { fileId: file.id })
}} />
```

```ts
importCsv: mutation({ input: z.object({ fileId: z.string() }), timeoutSeconds: 300 }, async (ctx, input) => {
  const text = await ctx.files.text(input.fileId)
  // ...
  const report = await ctx.files.write('report.csv', csv, 'text/csv')
  return { reportId: report.id }
}),
```

- In the UI: `files.upload(file, name?, onProgress?)`, `files.list()`, `useFiles()`, `files.read(file)` (a `Blob`), `files.url(file)` (an address for an `<img>`), `files.remove(id)`.
- To give the user a file: `files.save(file)` for an app file, and `files.saveAs(name, blob)` for one the UI made, such as an export. It is a download on a computer and the share sheet on a phone. Do not use `<a download>`: it does not work on a phone.
- One file is at most 64 MiB, and `saveAs` takes at most 16 MiB. An app holds at most 10,000 files.
- Use your own `<input type="file">` or a drop target. Show progress, and say when a file is too large.
- Keep the `id` of a file in your own tables when a row needs it. The user sees every app file in the Files section of the Manage page, and can delete one there: handle an id that is gone.
- For work on a large file that must not be lost, start a [workflow](workflows.md) from the mutation.
