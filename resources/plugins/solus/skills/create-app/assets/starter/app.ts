import { defineApp, mutation, query } from '@solus/app/backend'
import { z } from 'zod'
import { Note } from './src/schema'

/** The `notes` table is made by migrations/0001_notes.sql. */
export default defineApp({
  name: 'Notes',
  description: 'A place for short notes that you keep.',
  instructions: 'Search with list before you add a note, so that you do not add one twice.',
  config: {
    headline: { type: 'text', label: 'Headline', description: 'The line at the top of the page.', default: 'A little room for ideas.' },
    pageSize: { type: 'number', label: 'Notes on the page', description: 'How many of the newest notes the list shows.', default: 100, min: 10, max: 500, integer: true },
  },
  operations: {
    list: query(
      {
        description: 'The newest notes, as many as the page shows. Give search to keep only the notes that contain that text.',
        input: z.object({ search: z.string().default('') }),
        output: z.array(Note),
      },
      (ctx, input) => ctx.sql.exec<Note>(
        "SELECT id, text, created_at FROM notes WHERE text LIKE '%' || ? || '%' ORDER BY created_at DESC LIMIT ?",
        input.search, Number(ctx.config.pageSize),
      ).all(),
    ),
    get: query(
      { description: 'One note by its id.', input: z.object({ id: z.string() }), output: Note },
      (ctx, input) => {
        const note = ctx.sql.exec<Note>('SELECT id, text, created_at FROM notes WHERE id = ?', input.id).all()[0]
        if (!note) throw new Error('This note is gone. It was deleted.')
        return note
      },
    ),
    add: mutation(
      { description: 'Save one note.', input: z.object({ text: z.string().trim().min(1) }), output: Note },
      (ctx, input) => ctx.sql.exec<Note>(
        'INSERT INTO notes (id, text, created_at) VALUES (?, ?, ?) RETURNING id, text, created_at',
        crypto.randomUUID(), input.text, Date.now(),
      ).one(),
    ),
    remove: mutation(
      { description: 'Delete one note by its id.', input: z.object({ id: z.string() }), output: z.null() },
      (ctx, input) => {
        ctx.sql.exec('DELETE FROM notes WHERE id = ?', input.id)
        return null
      },
    ),
  },
})
