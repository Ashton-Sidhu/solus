import { describe, expect, test } from 'bun:test'
import {
  findAnchor,
  readTrigger,
  triggerRunPattern,
} from '@solus/workspace-ui/components/editor/unified-autocomplete/trigger'
import { fuzzy, rank } from '@solus/workspace-ui/components/editor/unified-autocomplete/rank'
import {
  buildRows,
  ghostFor,
  isSelectable,
  type MenuItem,
  type RowInput,
} from '@solus/workspace-ui/components/editor/unified-autocomplete/rows'
import { GLYPH, type RefKind } from '@solus/workspace-ui/components/editor/unified-autocomplete/kinds'
import { autocompleteSelectionAction } from '@solus/workspace-ui/components/editor/autocomplete-editor'

function reference(refKind: RefKind, title: string, meta = ''): MenuItem {
  return {
    id: `${refKind}:${title}`,
    title,
    meta,
    when: '',
    icon: GLYPH.file,
    mono: false,
    monoMeta: false,
    refKind,
    token: { kind: 'task', taskId: title, title },
  }
}

function input(text: string, overrides: Partial<RowInput> = {}): RowInput {
  const anchor = findAnchor(text)
  const trigger = readTrigger(text, anchor)
  if (!trigger) throw new Error(`no trigger in ${text}`)
  const empty = {
    plan: [],
    doc: [],
    pr: [],
    session: [],
    task: [],
    automation: [],
  }
  return {
    trigger,
    commands: [],
    openFiles: [],
    worktreeFiles: [],
    worktreeFileCount: null,
    byKind: empty,
    counts: { plan: 0, doc: 0, pr: 0, session: 0, task: 0, automation: 0 },
    ...overrides,
  }
}

describe('trigger grammar', () => {
  test('a category drilled into lives in the composer text, not in state', () => {
    // WHY: the whole state model rests on this. If the scope were component
    // state, undo, caret movement and text selection would each need their own
    // handling; parsing it back out of the text is what makes them free.
    const trigger = readTrigger('#automations/night', findAnchor('#automations/night'))
    expect(trigger?.path).toEqual(['automation'])
    expect(trigger?.query).toBe('night')
  })

  test('both the slug and the singular kind key resolve', () => {
    // WHY: slugs are a public surface the user types by hand.
    expect(readTrigger('#prs/flake', 0)?.path).toEqual(['pr'])
    expect(readTrigger('#pr/flake', 0)?.path).toEqual(['pr'])
  })

  test('an @ query keeps its slashes, because it is a path', () => {
    // WHY: only # scopes. Splitting an @ query on `/` would make every nested
    // path unreachable.
    const trigger = readTrigger('@src/renderer/', 0)
    expect(trigger?.path).toEqual([])
    expect(trigger?.query).toBe('src/renderer/')
  })

  test('file triggers accept filesystem paths outside the project', () => {
    // WHY: file autocomplete is not project-only; parent-relative, home, and
    // absolute paths are routed to the file channel so the server can browse
    // anywhere the host can read.
    expect(readTrigger('@../fixtures', findAnchor('@../fixtures'))).toMatchObject({
      char: '@',
      query: '../fixtures',
    })
    expect(readTrigger('@~/Desktop', findAnchor('@~/Desktop'))).toMatchObject({
      char: '@',
      query: '~/Desktop',
    })
    expect(readTrigger('@/Users', findAnchor('@/Users'))).toMatchObject({
      char: '@',
      query: '/Users',
    })
    expect(readTrigger('../fixtures', findAnchor('../fixtures'))).toMatchObject({
      char: '@',
      query: '../fixtures',
    })
    expect(readTrigger('/Users/sidhu', findAnchor('/Users/sidhu'))).toMatchObject({
      char: '@',
      query: '/Users/sidhu',
    })
  })

  test('a bare slash still opens commands', () => {
    // WHY: `/` is also the command trigger; absolute paths can use `@/` until
    // the bare path has enough shape to distinguish it from a command.
    expect(readTrigger('/', findAnchor('/'))).toMatchObject({
      char: '/',
      query: '',
    })
  })

  test('a trigger opens at line start or after whitespace, never mid-word', () => {
    // WHY: an email address or a path fragment must not open the menu.
    expect(findAnchor('ship it #412')).toBe(8)
    expect(findAnchor('user@example')).toBeNull()
  })

  test('accepting replaces the whole run, scope and spaces included', () => {
    // WHY: the run is what the user sees as one gesture. Leaving the scope slug
    // behind would put `#automations/` in the sent prompt beside the chip.
    const text = 'land #automations/nightly sweep'
    const pattern = triggerRunPattern(text, 5)
    expect(text.replace(pattern, 'CHIP')).toBe('land CHIP')
  })
})

describe('keyboard selection', () => {
  test('Tab commits the selected row just like Enter', () => {
    // WHY: hovering a file or any other individual item makes it the selected
    // row. Tab must commit that row, not merely extend a prefix completion.
    expect(autocompleteSelectionAction('Tab', false)).toBe('activate')
    expect(autocompleteSelectionAction('Enter', false)).toBe('activate')
    expect(autocompleteSelectionAction('ArrowRight', false)).toBeNull()
  })

  test('Tab drills into a selected directory while Enter can still insert it', () => {
    // WHY: the former file browser used Tab as traversal for directories. Files
    // still commit on Tab, but directories must remain browsable in-place.
    expect(autocompleteSelectionAction('Tab', true)).toBe('drill')
    expect(autocompleteSelectionAction('Enter', true)).toBe('activate')
  })
})

describe('ranking', () => {
  test('menu title parts replace embedded line breaks without shifting highlights', () => {
    // WHY: provider titles can contain newlines. A fixed-height menu row must
    // remain one line, and the highlighted query must still mark the same text.
    const [match] = rank(
      [reference('plan', 'Implement the plan:\nread docs/plans/host.md')],
      'docs',
    )
    expect(match.parts.map((part) => part.text).join('')).toBe(
      'Implement the plan: read docs/plans/host.md',
    )
    expect(match.parts.filter((part) => part.hit).map((part) => part.text)).toEqual([
      'docs',
    ])
  })

  test('the score ladder prefers a prefix over a boundary over a substring', () => {
    // WHY: this ordering is what makes three typed letters land on the thing you
    // meant without a category picker in front of it.
    const prefix = fuzzy('palette flicker', 'pal')!.score
    const boundary = fuzzy('fix palette', 'pal')!.score
    const substring = fuzzy('repalette', 'pal')!.score
    const subsequence = fuzzy('pull all', 'pal')!.score
    expect(prefix).toBeLessThan(boundary)
    expect(boundary).toBeLessThan(substring)
    expect(substring).toBeLessThan(subsequence)
  })

  test('a metadata-only match ranks below every title match and highlights nothing', () => {
    // WHY: highlighting characters the query did not match in the title would
    // claim a match that isn't there.
    const [onMeta] = rank([reference('pr', 'Fix the flake', 'merged')], 'merged')
    expect(onMeta.score).toBeGreaterThanOrEqual(9)
    expect(onMeta.parts.every((part) => !part.hit)).toBe(true)
  })

  test('a metadata subsequence is not a match', () => {
    // WHY: fuzzy matching across metadata matches nearly everything, which would
    // make the whole index noise.
    expect(rank([reference('pr', 'Fix the flake', 'open · checks passing')], 'ocp')).toHaveLength(0)
  })
})

describe('menu rows', () => {
  test('duplicate slash commands keep one keyed row', () => {
    // WHY: provider-discovered commands can overlap Solus built-ins. The menu is
    // keyed by command id, so duplicates would crash Svelte before the user can
    // choose either row.
    const rows = buildRows(
      input('/cl', {
        commands: [
          {
            id: 'cmd:/clear',
            title: 'clear',
            meta: 'Clear current conversation',
            when: '',
            icon: GLYPH.cmd,
            mono: true,
            monoMeta: false,
            token: { kind: 'slash', command: '/clear' },
          },
          {
            id: 'cmd:/clear',
            title: 'clear',
            meta: 'Clear provider transcript',
            when: '',
            icon: GLYPH.cmd,
            mono: true,
            monoMeta: false,
            token: { kind: 'slash', command: '/clear' },
          },
        ],
      }),
    )

    expect(rows.map((row) => row.key)).toEqual(['cmd:cmd:/clear'])
  })

  test('every item is reachable from the root by typing, without drilling', () => {
    // WHY: acceptance criterion 04 — the category level exists for browsing, not
    // for access.
    const rows = buildRows(
      input('#night', {
        byKind: {
          plan: [],
          doc: [],
          pr: [],
          session: [],
          task: [],
          automation: [reference('automation', 'Nightly dependency sweep')],
        },
      }),
    )
    const titles = rows.flatMap((row) => (row.type === 'item' ? [row.item.title] : []))
    expect(titles).toContain('Nightly dependency sweep')
  })

  test('no query, however typed, produces an empty popover', () => {
    // WHY: acceptance criterion 07 — a dead end always offers a next move.
    for (const text of ['/zzz', '@zzz', '#zzz', '#automations/zzz']) {
      const rows = buildRows(input(text)).filter(isSelectable)
      expect(rows.length).toBeGreaterThan(0)
    }
  })

  test('the header row of a drilled category is not selectable', () => {
    // WHY: ↑↓ moves through things you can act on. The header is the subject on
    // screen and the way back, not a stop on the way down the list.
    const rows = buildRows(
      input('#automations/', {
        byKind: {
          plan: [],
          doc: [],
          pr: [],
          session: [],
          task: [],
          automation: [reference('automation', 'PR triage on open')],
        },
      }),
    )
    expect(rows[0].type).toBe('header')
    expect(rows.filter(isSelectable)).toHaveLength(1)
  })

  test('the grey completion equals the text pressing → produces', () => {
    // WHY: acceptance criterion 05. A category ghost carries the trailing slash
    // because drilling writes one.
    const rows = buildRows(input('#auto'))
    const category = rows.filter(isSelectable)[0]
    expect(category.type).toBe('category')
    expect(ghostFor(category, 'auto')).toBe('mations/')
  })

  test('a category ghost is withheld when the query only fuzzy-matched', () => {
    // WHY: a completion that is not a prefix would rewrite what the user typed.
    const rows = buildRows(input('#atn'))
    expect(ghostFor(rows.filter(isSelectable)[0] ?? null, 'atn')).toBe('')
  })

  test('path browsing does not re-filter server file results by the whole path', () => {
    // WHY: the server resolves `../`, `~/` and `/` queries before returning
    // directory children. Client ranking must use only the basename segment, or
    // every child of `@../` and `@/Users/` disappears.
    const child = {
      id: 'file:/Users/sidhu/package.json',
      title: 'package.json',
      meta: '/Users/sidhu/',
      when: '',
      icon: GLYPH.file,
      mono: true,
      monoMeta: true,
      token: { kind: 'file', path: '/Users/sidhu/package.json', name: 'package.json' },
    } satisfies MenuItem

    const parentRows = buildRows(
      input('@../', { worktreeFiles: [child], worktreeFileCount: 1 }),
    ).filter(isSelectable)
    expect(parentRows).toHaveLength(1)

    const absoluteRows = buildRows(
      input('@/Users/', { worktreeFiles: [child], worktreeFileCount: 1 }),
    ).filter(isSelectable)
    expect(absoluteRows).toHaveLength(1)
  })

  test('file autocomplete keeps the full server-ranked result page', () => {
    // WHY: the former file menu displayed every searchFiles result and searched
    // again as the user typed. Capping or re-filtering that page hides valid
    // individual files, especially fuzzy matches found through their paths.
    const files = Array.from({ length: 12 }, (_, index) => ({
      id: `file:src/renderer/item-${index}.ts`,
      title: `item-${index}.ts`,
      meta: 'src/renderer/',
      when: '',
      icon: GLYPH.file,
      mono: true,
      monoMeta: true,
      token: {
        kind: 'file' as const,
        path: `src/renderer/item-${index}.ts`,
        name: `item-${index}.ts`,
      },
    }))

    const rows = buildRows(
      input('@srd', { worktreeFiles: files, worktreeFileCount: files.length }),
    ).filter((row) => row.type === 'item')

    expect(rows).toHaveLength(files.length)
    expect(
      rows.map((row) => row.type === 'item' ? row.item.token.path : null),
    ).toEqual(files.map((file) => file.token.path))
  })
})
