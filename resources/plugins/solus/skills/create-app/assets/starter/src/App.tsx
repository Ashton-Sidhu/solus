import { useEffect, useRef, useState, type RefObject } from 'react'
import { ArrowLeft, ArrowUpRight, RotateCw, Search, Sparkle, Trash2 } from 'lucide-react'
import { appClient } from '@solus/app'
import type app from '../app'
import { useRoute } from './route'

const api = appClient<typeof app>()
const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export default function App() {
  const [page, id] = useRoute()
  return (
    <div className="min-h-dvh bg-page font-sans text-ink">
      <main className="mx-auto flex min-h-dvh max-w-225 flex-col px-8 max-sm:px-5">
        <header className="flex h-20 items-center justify-between border-b border-line max-sm:h-16">
          <a href="#/" className="flex items-center gap-2.5 text-[15px] font-semibold">
            <span className="grid size-7 place-items-center rounded-lg border border-line-strong bg-surface text-mark" aria-hidden="true">
              <ArrowUpRight size={16} strokeWidth={1.75} />
            </span>
            Notes
          </a>
          <LiveStatus />
        </header>
        {page === 'notes' && id ? <NotePage id={id} /> : <NotesPage />}
        <footer className="mt-10 flex justify-between py-7.5 text-[11px] text-ink-faint">
          Notes <span>Made with Solus</span>
        </footer>
      </main>
    </div>
  )
}

/** Live while the app answers: its queries run again by themselves when its data changes. */
function LiveStatus() {
  const notes = api.useQuery('list', { search: '' })
  const label = notes.data === undefined && notes.loading ? 'Connecting…' : notes.error ? 'Offline' : 'Live'
  return (
    <span className="flex items-center gap-1.5 text-xs text-ink-soft">
      <span className={`size-1.5 rounded-full ${label === 'Live' ? 'bg-live' : 'bg-ink-faint'}`} aria-hidden="true" />
      {label}
    </span>
  )
}

function NotesPage() {
  const [search, setSearch] = useState('')
  const notes = api.useQuery('list', { search: search.trim() })
  // The headline is a config field: the owner changes it on the app's Manage page.
  const config = api.useConfig()
  const composer = useRef<HTMLInputElement>(null)
  const searchField = useRef<HTMLInputElement>(null)

  // `/` goes to the search field, as in most apps with a list.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      event.preventDefault()
      searchField.current?.focus()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <section className="pt-16 pb-9 max-sm:pt-10">
        <span className="text-[11px] font-semibold tracking-[0.12em] text-ink-soft">YOUR SPACE</span>
        <h1 className="mt-3.5 mb-2.5 min-h-[1.2em] text-[clamp(26px,5vw,36px)] font-medium tracking-[-0.04em] text-balance">{config.data?.headline}</h1>
        <p className="m-0 text-sm text-ink-soft">Leave a thought. It is here when you return, and your agents can read it too.</p>
      </section>
      <Composer inputRef={composer} />
      <section className="flex-1 pt-9.5" aria-labelledby="notes-title">
        <div className="flex items-center gap-3 border-b border-line pb-3.5">
          <h2 id="notes-title" className="m-0 text-[13px] font-[550]">Notes</h2>
          <span className="text-[11px] text-ink-faint tabular-nums">{notes.data?.length ?? 0}</span>
          <label className="ml-auto flex h-8 w-52 items-center gap-2 rounded-[7px] border border-line bg-field px-2.5 text-[13px] focus-within:border-mark max-sm:w-36">
            <Search size={14} strokeWidth={1.75} className="shrink-0 text-ink-faint" aria-hidden="true" />
            <input ref={searchField} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" aria-label="Search notes" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-ink-faint" />
            <kbd className="text-[11px] text-ink-faint max-sm:hidden">/</kbd>
          </label>
        </div>
        {notes.error && (
          <p role="alert" className="mt-3 flex items-center gap-3 text-[13px] text-danger">
            <span className="min-w-0 flex-1">{notes.error}</span>
            <button type="button" onClick={notes.refresh} className="flex items-center gap-1.5 font-medium">
              <RotateCw size={14} strokeWidth={1.75} aria-hidden="true" /> Try again
            </button>
          </p>
        )}
        {notes.data === undefined ? (
          notes.loading && <p className="py-16 text-center text-sm text-ink-faint">Loading your notes…</p>
        ) : notes.data.length === 0 ? (
          search.trim() ? (
            <Empty title={`No note contains “${search.trim()}”.`} action="Clear the search" onAction={() => setSearch('')} />
          ) : (
            <Empty title="A clean slate." text="Your first note goes here." action="Write the first note" onAction={() => composer.current?.focus()} />
          )
        ) : (
          <ul className={`m-0 list-none p-0 transition-opacity ${notes.loading ? 'opacity-60' : ''}`}>
            {notes.data.map((note) => (
              <li key={note.id} className="border-b border-line">
                <a href={`#/notes/${encodeURIComponent(note.id)}`} className="group flex items-start gap-3.5 px-0.5 py-5 transition-colors hover:bg-surface max-sm:py-4">
                  <ArrowUpRight size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-mark" aria-hidden="true" />
                  <span className="min-w-0 flex-1 text-sm leading-relaxed" title={note.text}>{note.text}</span>
                  <time className="shrink-0 pt-0.5 text-[11px] text-ink-faint tabular-nums max-sm:hidden">{when.format(note.created_at)}</time>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}

function Composer({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string>()

  const submit = async () => {
    if (!text.trim() || saving) return
    setSaving(true)
    setFailure(undefined)
    try {
      await api.mutate('add', { text: text.trim() })
      setText('')
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not save your note. Try again.')
    } finally {
      setSaving(false)
      inputRef.current?.focus()
    }
  }

  return (
    <form onSubmit={(event) => { event.preventDefault(); void submit() }} className="rounded-xl border border-line bg-surface p-5 max-sm:p-4">
      <label htmlFor="note-text" className="mb-3 block text-xs font-[550]">New note</label>
      <div className="flex gap-3 max-sm:flex-col">
        <input
          ref={inputRef}
          id="note-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="What is on your mind?"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-[7px] border border-line bg-field px-3 py-2.75 text-sm outline-none placeholder:text-ink-faint focus:border-mark max-sm:flex-none"
        />
        <button type="submit" disabled={saving || !text.trim()} className="rounded-[7px] bg-accent px-4.25 text-xs font-[550] text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50 max-sm:min-h-10.5">
          {saving ? 'Saving…' : 'Add note'}
        </button>
      </div>
      {failure && <p role="alert" className="mt-3 mb-0 text-[13px] text-danger">{failure}</p>}
    </form>
  )
}

function NotePage({ id }: { id: string }) {
  // The page loads what it shows by the id in the address, so a reload works.
  const note = api.useQuery('get', { id })
  const confirm = useRef<HTMLDialogElement>(null)
  const [deleting, setDeleting] = useState(false)
  const [failure, setFailure] = useState<string>()

  const remove = async () => {
    setDeleting(true)
    setFailure(undefined)
    try {
      await api.mutate('remove', { id })
      location.hash = '#/'
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The note was not deleted. Try again.')
      setDeleting(false)
    }
  }

  return (
    <section className="flex-1 pt-10">
      <a href="#/" className="inline-flex items-center gap-1.5 text-[13px] text-ink-soft transition-colors hover:text-ink">
        <ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" /> All notes
      </a>
      {note.data ? (
        <article className="mt-6 rounded-xl border border-line bg-surface p-8 max-sm:p-5">
          <time className="text-[11px] text-ink-faint tabular-nums">{when.format(note.data.created_at)}</time>
          <p className="mt-3 mb-0 text-xl leading-relaxed font-medium tracking-[-0.02em] whitespace-pre-wrap">{note.data.text}</p>
          <div className="mt-8 flex justify-end border-t border-line pt-4">
            <button type="button" onClick={() => confirm.current?.showModal()} className="flex items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-xs font-[550] text-danger transition-colors hover:bg-field">
              <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" /> Delete note
            </button>
          </div>
        </article>
      ) : note.error ? (
        <Empty title={note.error} action="Back to all notes" onAction={() => { location.hash = '#/' }} />
      ) : (
        <p className="py-16 text-center text-sm text-ink-faint">Loading the note…</p>
      )}
      <dialog ref={confirm} className="m-auto w-[min(22rem,calc(100%-2rem))] rounded-xl border border-line bg-surface p-5 text-ink">
        <h2 className="m-0 text-[15px] font-semibold">Delete this note?</h2>
        <p className="mt-1.5 mb-0 text-[13px] text-ink-soft">You cannot undo this.</p>
        {failure && <p role="alert" className="mt-3 mb-0 text-[13px] text-danger">{failure}</p>}
        <form method="dialog" className="mt-5 flex justify-end gap-2">
          <button className="rounded-[7px] border border-line px-3.5 py-2 text-xs font-[550]">Cancel</button>
          <button type="button" onClick={remove} disabled={deleting} className="rounded-[7px] bg-danger px-3.5 py-2 text-xs font-[550] text-white disabled:opacity-50">
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </form>
      </dialog>
    </section>
  )
}

function Empty({ title, text, action, onAction }: { title: string; text?: string; action: string; onAction: () => void }) {
  return (
    <div className="flex flex-col items-center py-16 text-center">
      <Sparkle size={28} strokeWidth={1.5} className="text-mark" aria-hidden="true" />
      <h3 className="mt-4.5 mb-1.5 text-sm font-medium text-ink-soft">{title}</h3>
      {text && <p className="m-0 text-xs text-ink-faint">{text}</p>}
      <button type="button" onClick={onAction} className="mt-4 text-xs font-[550] text-mark hover:underline">{action}</button>
    </div>
  )
}
