import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState } from 'react'
import { Button, Card, CardDescription, CardTitle, Empty, Input, Skeleton, storage } from '@solus/app'

// A starter that shows the shape of an app: data the app keeps (`storage`), a
// query that reads it, a mutation that writes it, and the three states of a
// list. Replace all of it.

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
    <div className="grid gap-4">
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); add() }}>
        <Input aria-label="New note" placeholder="Write a note" value={draft} onChange={(event) => setDraft(event.target.value)} className="flex-1" />
        <Button type="submit" variant="primary" disabled={!draft.trim() || !notes.data || save.isPending}>Add</Button>
      </form>
      {notes.isPending ? (
        <Skeleton className="h-24" />
      ) : notes.isError ? (
        <Card role="alert">
          <CardTitle>The notes did not load</CardTitle>
          <CardDescription className="mt-1">{notes.error.message}</CardDescription>
          <Button className="mt-3" onClick={() => void notes.refetch()}>Try again</Button>
        </Card>
      ) : notes.data.length === 0 ? (
        <Empty title="No notes yet">This app keeps its notes on the host. They are here when you open it again.</Empty>
      ) : (
        <Card className="p-0">
          <ul>
            {notes.data.map((note) => (
              <li key={note.id} className="flex items-center gap-2 border-t border-border/50 py-1.5 pr-1.5 pl-4 first:border-t-0">
                <span className="min-w-0 flex-1 text-[13px] break-words">{note.text}</span>
                <Button variant="ghost" className="w-8 px-0" aria-label={`Delete note: ${note.text}`} onClick={() => save.mutate(notes.data.filter((other) => other.id !== note.id))}>
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {save.isError ? <p role="alert" className="text-[13px] text-destructive">{save.error.message}</p> : null}
    </div>
  )
}
