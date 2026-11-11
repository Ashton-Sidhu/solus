import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button, Card, CardDescription, CardTitle, Empty, Input, Skeleton, storage } from '@solus/app'

// A starter that shows the shape of an app: state the app keeps (`storage`),
// a query that reads it, and a mutation that writes it. Replace all of it.

interface Note {
  id: string
  text: string
}

const NOTES_KEY = ['notes']

export default function App() {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const notes = useQuery({ queryKey: NOTES_KEY, queryFn: async () => (await storage.get<Note[]>('notes')) ?? [] })
  const save = useMutation({
    mutationFn: (next: Note[]) => storage.set('notes', next),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTES_KEY }),
  })

  function add() {
    const text = draft.trim()
    if (!text || !notes.data) return
    save.mutate([...notes.data, { id: crypto.randomUUID(), text }])
    setDraft('')
  }

  return (
    <div className="grid gap-3">
      <Card>
        <CardTitle>Notes</CardTitle>
        <CardDescription className="mt-1">This app keeps its notes on the host. They are here when you open it again.</CardDescription>
        <form className="mt-3 flex gap-2" onSubmit={(event) => { event.preventDefault(); add() }}>
          <Input aria-label="New note" placeholder="Write a note" value={draft} onChange={(event) => setDraft(event.target.value)} className="min-w-0 flex-1" />
          <Button type="submit" variant="primary" disabled={!draft.trim() || !notes.data || save.isPending}>Add</Button>
        </form>
      </Card>
      {notes.isPending ? (
        <Skeleton className="h-16" />
      ) : notes.isError ? (
        <Card role="alert">
          <CardTitle>The notes did not load</CardTitle>
          <CardDescription className="mt-1">{notes.error.message}</CardDescription>
        </Card>
      ) : notes.data.length === 0 ? (
        <Empty title="No notes yet">Add the first one above.</Empty>
      ) : (
        <ul className="grid gap-2">
          {notes.data.map((note) => (
            <li key={note.id} className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
              <span className="min-w-0 flex-1 break-words">{note.text}</span>
              <Button variant="ghost" aria-label={`Delete note: ${note.text}`} onClick={() => save.mutate(notes.data.filter((other) => other.id !== note.id))}>Delete</Button>
            </li>
          ))}
        </ul>
      )}
      {save.isError ? <p role="alert" className="text-sm text-destructive">{save.error.message}</p> : null}
    </div>
  )
}
