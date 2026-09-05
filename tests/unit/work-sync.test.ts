import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DocDiagramAsset, DocDraft, DocPatch, DocReadHints, DocRef, DocScope, NormalizedDoc } from '@solus/contracts/docs'
import { serializeDiagramEmbed } from '@solus/contracts/diagram-embed'
import { serializeWorkEmbed } from '@solus/contracts/work-embed'
import { DocVersionConflictError } from '@solus/server/docs/types'

/**
 * Publish and pull against the real works store, on a throwaway data dir. The
 * link's persistence is half of what these rules are — a conflict the header
 * forgets on reload is not a conflict — so only the provider is stubbed.
 */

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const now = '2026-08-22T10:00:00.000Z'

/** The fake upstream doc, plus what the last call to it carried. */
interface FakeUpstream {
  version: string
  markdown: string
  title: string
  lastPatch: DocPatch | null
  lastDraft: DocDraft | null
  lastScope: DocScope | null
  lastAssets: DocDiagramAsset[] | null
  lastReadHints: DocReadHints | null
  beforeUpdate: (() => void | Promise<void>) | null
}

const upstream: FakeUpstream = {
  version: '5',
  markdown: '# Upstream',
  title: 'Upstream title',
  lastPatch: null,
  lastDraft: null,
  lastScope: null,
  lastAssets: null,
  lastReadHints: null,
  beforeUpdate: null,
}

const adapter = {
  id: 'confluence' as const,
  status: async () => ({ provider: 'confluence' as const, connected: true }),
  destinations: async () => [],
  search: async () => [],
  read: async (ref: DocRef, hints?: DocReadHints): Promise<NormalizedDoc> => {
    upstream.lastReadHints = hints ?? null
    return {
      ref,
      title: upstream.title,
      markdown: upstream.markdown,
      version: upstream.version,
      updatedAt: now,
    }
  },
  create: async (scope: DocScope, doc: DocDraft): Promise<NormalizedDoc> => {
    upstream.lastScope = scope
    upstream.lastAssets = doc.diagramAssets ?? null
    upstream.lastDraft = doc
    return {
      ref: {
        provider: 'confluence',
        externalKey: 'cloud/ENG',
        externalId: 'new-page',
        url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/new-page/Spec',
      },
      title: doc.title,
      markdown: doc.markdown,
      version: '1',
      updatedAt: now,
    }
  },
  update: async (ref: DocRef, patch: DocPatch): Promise<NormalizedDoc> => {
    upstream.lastPatch = patch
    await upstream.beforeUpdate?.()
    if (patch.expectedVersion !== undefined && patch.expectedVersion !== upstream.version) {
      throw new DocVersionConflictError(upstream.version, now)
    }
    return { ref, title: patch.title ?? upstream.title, markdown: patch.markdown, version: '6', updatedAt: now }
  },
  resolveUrl: () => null,
}

// The registry keeps every other export, because bun's module mocks are
// process-wide and another file's real registry must survive this one.
const actualRegistry = await import('@solus/server/docs/registry')
mock.module('@solus/server/docs/registry', () => ({
  ...actualRegistry,
  docProviderAdapter: () => adapter,
  resolveDocUrl: () => ({
    adapter,
    ref: { provider: 'confluence', externalKey: 'cloud/ENG', externalId: '98765', url: 'https://acme.atlassian.net/wiki/x' },
  }),
}))

let works: typeof import('@solus/server/folio/works')
let workSync: typeof import('@solus/server/folio/work-sync')
let planSync: typeof import('@solus/server/plans/plan-sync')
let annotations: typeof import('@solus/server/plans/annotations')
let workId: string

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'solus-work-sync-'))
  works = await import('@solus/server/folio/works')
  workSync = await import('@solus/server/folio/work-sync')
  planSync = await import('@solus/server/plans/plan-sync')
  annotations = await import('@solus/server/plans/annotations')
})

async function newWork(content = '# Local', type: 'doc' | 'slides' = 'doc'): Promise<string> {
  const work = await works.createWork('Spec', type, content, '', undefined, 'claude-code', '~')
  return work.id
}

async function linkOf(id: string) {
  return (await works.loadWork(id))?.mirroredDoc
}

const ENGINEERING = { provider: 'confluence' as const, scope: 'ENG', label: 'Engineering' }

beforeEach(async () => {
  upstream.version = '5'
  upstream.lastPatch = null
  upstream.lastScope = null
  upstream.lastAssets = null
  upstream.lastReadHints = null
  upstream.beforeUpdate = null
  workId = await newWork()
})

describe('publishWork', () => {
  test('asks for a destination on the first publish rather than guessing one', async () => {
    const result = await workSync.publishWork(workId)

    expect(result.ok).toBe(false)
    expect(await linkOf(workId)).toBeUndefined()
  })

  test('remembers the chosen destination so later publishes need no picker', async () => {
    const result = await workSync.publishWork(workId, { destination: ENGINEERING })

    expect(result.ok).toBe(true)
    expect(upstream.lastScope).toBe('ENG')
    const link = await linkOf(workId)
    expect(link?.scope).toBe('ENG')
    expect(link?.upstreamVersion).toBe('1')
  })

  test('reads back as dirty once the document moves on from what was published', async () => {
    await workSync.publishWork(workId, { destination: ENGINEERING })
    expect((await linkOf(workId))?.syncState).toBe('ok')

    await works.saveWork(workId, { content: '# Local, edited' })

    // Derived from the content, not stored: an edit never touches the link.
    expect((await linkOf(workId))?.syncState).toBe('dirty')
  })

  test('refuses a deck — v1 publishes documents only', async () => {
    const slidesId = await newWork('# Deck', 'slides')

    const result = await workSync.publishWork(slidesId, { destination: ENGINEERING })

    expect(result).toMatchObject({ ok: false })
    expect(upstream.lastScope).toBeNull()
  })

  test('reports a conflict, and does not overwrite, when upstream moved', async () => {
    await workSync.publishWork(workId, { destination: ENGINEERING })
    upstream.version = '9'
    await works.saveWork(workId, { content: '# Local, edited' })

    const result = await workSync.publishWork(workId)

    expect(result).toMatchObject({ ok: false, conflict: true })
    // Stored, so the header still says conflict after a reload.
    expect((await linkOf(workId))?.syncState).toBe('conflict')
  })

  test('publishes over an upstream change only when the user chose to', async () => {
    await workSync.publishWork(workId, { destination: ENGINEERING })
    upstream.version = '9'
    await works.saveWork(workId, { content: '# Local, edited' })

    const result = await workSync.publishWork(workId, { force: true })

    expect(result.ok).toBe(true)
    expect(upstream.lastPatch?.expectedVersion).toBeUndefined()
    expect((await linkOf(workId))?.syncState).toBe('ok')
  })

  test('flattens an embedded diagram and says so, instead of publishing a Solus token', async () => {
    const withDiagram = await newWork(`# Spec\n\n${serializeDiagramEmbed({ workId: 'd1', title: 'Architecture' })}\n`)

    const result = await workSync.publishWork(withDiagram, { destination: ENGINEERING })

    expect(result.ok && result.lossyParts).toEqual(['diagram: Architecture'])
  })

  test('an artifact embed publishes as a caption, never as a work:// link', async () => {
    // WHY: no provider runs HTML, and publishing a render as a picture is out
    // of scope. What matters is that the token never reaches the page, where it
    // would read as a broken link the reader can neither follow nor fix.
    const withArtifact = await newWork(
      `# Spec\n\n${serializeWorkEmbed({ workId: 'a1', title: 'Latency', type: 'artifact' })}\n`,
    )

    const result = await workSync.publishWork(withArtifact, { destination: ENGINEERING })

    expect(result.ok && result.lossyParts).toEqual(['artifact: Latency'])
    expect(upstream.lastDraft?.markdown).toContain('_Artifact: Latency — view it in Solus._')
    expect(upstream.lastDraft?.markdown).not.toContain('work://')
  })

  test('prepared diagram assets do not carry an artifact embed with them', async () => {
    // WHY: the assets say the client drew the diagrams. It cannot draw an
    // artifact, so that embed still has to flatten in the same publish.
    const content = [
      '# Spec',
      '',
      serializeDiagramEmbed({ workId: 'd1', title: 'Architecture' }),
      '',
      serializeWorkEmbed({ workId: 'a1', title: 'Latency', type: 'artifact' }),
      '',
    ].join('\n')
    const withBoth = await newWork(content)

    const result = await workSync.publishWork(withBoth, {
      destination: { provider: 'gdrive', scope: 'root', label: 'My Drive' },
      diagramAssets: [{
        workId: 'd1',
        title: 'Architecture',
        mimeType: 'image/png',
        base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      }],
    })

    expect(result.ok && result.lossyParts).toEqual(['artifact: Latency'])
    expect(upstream.lastDraft?.markdown).toContain('type=diagram')
    expect(upstream.lastDraft?.markdown).not.toContain('type=artifact')
  })

  test('carries prepared diagram PNGs through the tracked Google publish', async () => {
    const content = `# Spec\n\n${serializeDiagramEmbed({ workId: 'd1', title: 'Architecture' })}\n`
    const withDiagram = await newWork(content)
    const asset: DocDiagramAsset = {
      workId: 'd1',
      title: 'Architecture',
      mimeType: 'image/png',
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    }

    const result = await workSync.publishWork(withDiagram, {
      destination: { provider: 'gdrive', scope: 'root', label: 'My Drive' },
      diagramAssets: [asset],
    })

    expect(result.ok).toBe(true)
    expect(upstream.lastAssets).toEqual([asset])
    expect(result.ok && result.lossyParts).toBeUndefined()
  })

  test('remembers which diagrams went up as images, and hands them to the pull', async () => {
    // WHY: Docs returns an embedded diagram as a base64 image with no trace of
    // the Solus work it came from. The link is the only place that memory can
    // live, since a plan pull has no local content to compare against.
    const content = `# Spec\n\n${serializeDiagramEmbed({ workId: 'd1', title: 'Architecture' })}\n`
    const withDiagram = await newWork(content)
    const asset: DocDiagramAsset = { workId: 'd1', title: 'Architecture', mimeType: 'image/png', base64: 'iVBORw0KGgo=' }

    await workSync.publishWork(withDiagram, {
      destination: { provider: 'gdrive', scope: 'root', label: 'My Drive' },
      diagramAssets: [asset],
    })
    expect((await linkOf(withDiagram))?.diagrams).toEqual([{ workId: 'd1', title: 'Architecture' }])

    upstream.version = '9'
    await workSync.pullWorkUpstream(withDiagram)
    expect(upstream.lastReadHints?.diagrams).toEqual([{ workId: 'd1', title: 'Architecture' }])
  })
})

describe('plan mirror', () => {
  test('persists a plan revision link and uses it for later updates', async () => {
    await annotations.saveAnnotations({
      version: 1,
      sessionId: 'session-plan',
      planToolUseId: 'tool-1',
      projectPath: '/tmp/project',
      cwd: '/tmp/project',
      title: 'Plan',
      status: 'pending',
      comments: [],
      bookmarked: false,
      updatedAt: Date.now(),
    })

    const first = await planSync.publishPlan({
      sessionId: 'session-plan',
      planToolUseId: 'tool-1',
      title: 'Plan',
      content: '# Plan',
      destination: ENGINEERING,
    })
    expect(first.ok).toBe(true)
    expect((await annotations.loadAnnotations('session-plan', 'tool-1'))?.mirroredDoc?.externalId).toBe('new-page')

    upstream.version = '1'
    const update = await planSync.publishPlan({
      sessionId: 'session-plan',
      planToolUseId: 'tool-1',
      title: 'Plan',
      content: '# Revised plan',
    })
    expect(update.ok).toBe(true)
    expect(upstream.lastPatch?.markdown).toBe('# Revised plan')
  })

  test('carries an embedded diagram PNG through the plan mirror', async () => {
    await annotations.saveAnnotations({
      version: 1,
      sessionId: 'session-plan-png',
      planToolUseId: 'tool-png',
      projectPath: '/tmp/project',
      cwd: '/tmp/project',
      title: 'Plan with diagram',
      status: 'pending',
      comments: [],
      bookmarked: false,
      updatedAt: Date.now(),
    })
    const content = `# Plan\n\n${serializeDiagramEmbed({ workId: 'd1', title: 'Architecture' })}\n`
    const asset: DocDiagramAsset = {
      workId: 'd1',
      title: 'Architecture',
      mimeType: 'image/png',
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    }

    const result = await planSync.publishPlan({
      sessionId: 'session-plan-png',
      planToolUseId: 'tool-png',
      title: 'Plan with diagram',
      content,
      destination: { provider: 'gdrive', scope: 'root', label: 'My Drive' },
      diagramAssets: [asset],
    })

    expect(result.ok).toBe(true)
    expect(upstream.lastAssets).toEqual([asset])
  })

  test('merges the mirror link into annotations changed during publish', async () => {
    // WHY: publishing waits on the provider. Comments and review state saved in
    // that interval must not be replaced by the pre-request annotation copy.
    await annotations.saveAnnotations({
      version: 1,
      sessionId: 'session-plan-race',
      planToolUseId: 'tool-race',
      projectPath: '/tmp/project',
      cwd: '/tmp/project',
      title: 'Old title',
      status: 'pending',
      comments: [],
      bookmarked: false,
      updatedAt: Date.now(),
    })
    const first = await planSync.publishPlan({
      sessionId: 'session-plan-race',
      planToolUseId: 'tool-race',
      title: 'Plan',
      content: '# Plan',
      destination: ENGINEERING,
    })
    expect(first.ok).toBe(true)
    upstream.version = '1'
    upstream.beforeUpdate = async () => {
      const current = await annotations.loadAnnotations('session-plan-race', 'tool-race')
      if (!current) throw new Error('missing plan annotations')
      await annotations.saveAnnotations({
        ...current,
        title: 'Reviewed title',
        status: 'accepted',
        bookmarked: true,
        comments: [{ id: 'comment-1', selectedText: 'Plan', comment: 'Keep this.' }],
      })
    }

    await planSync.publishPlan({
      sessionId: 'session-plan-race',
      planToolUseId: 'tool-race',
      title: 'Plan',
      content: '# Revised plan',
    })

    const saved = await annotations.loadAnnotations('session-plan-race', 'tool-race')
    expect(saved).toMatchObject({
      title: 'Reviewed title',
      status: 'accepted',
      bookmarked: true,
      comments: [{ id: 'comment-1', comment: 'Keep this.' }],
      mirroredDoc: { upstreamVersion: '6' },
    })
  })
})

describe('pullWorkUpstream', () => {
  test('writes upstream content as a revertable local version and settles the link', async () => {
    await workSync.publishWork(workId, { destination: ENGINEERING })
    upstream.version = '9'

    const result = await workSync.pullWorkUpstream(workId)

    expect(result.ok).toBe(true)
    expect((await works.loadWork(workId))?.content).toBe('# Upstream')
    // A pull the user dislikes has to be one revert away.
    expect((await works.loadWorkPrevious(workId))?.content).toBe('# Local')
    const link = await linkOf(workId)
    expect(link?.upstreamVersion).toBe('9')
    expect(link?.syncState).toBe('ok')
  })
})

describe('refreshUpstreamState', () => {
  test('flags an upstream change without downloading over the local content', async () => {
    await workSync.publishWork(workId, { destination: ENGINEERING })
    upstream.version = '9'
    upstream.markdown = '# Upstream, edited by someone else'

    const link = await workSync.refreshUpstreamState(workId)

    expect(link?.syncState).toBe('upstream_changed')
    expect((await works.loadWork(workId))?.content).toBe('# Local')
    // The guard keeps the version it last published against, so a publish
    // over that edit is still refused as a conflict.
    expect(link?.upstreamVersion).toBe('1')
  })

  test('a version counter that moves on its own is not an upstream change', async () => {
    // WHY: Google Docs commits its own revisions after a write, so the Drive
    // version rises within seconds of a publish while the document still says
    // exactly what Solus sent. Reporting that as someone else's edit put every
    // freshly published work into "upstream changed" immediately.
    await workSync.publishWork(workId, { destination: ENGINEERING })
    upstream.version = '9'

    const link = await workSync.refreshUpstreamState(workId)

    expect(link?.syncState).toBe('ok')
    // Recorded, so the same unchanged doc is not re-compared on every poll.
    expect(link?.upstreamVersion).toBe('9')
  })

  test('reads with the published diagrams, or their captions would look like an edit', async () => {
    // WHY: a read without the hint renders each embed as a lossy caption, so
    // the markdown differs from the pull's and every check reports a change.
    const content = `# Spec\n\n${serializeDiagramEmbed({ workId: 'd1', title: 'Architecture' })}\n`
    const withDiagram = await newWork(content)
    await workSync.publishWork(withDiagram, {
      destination: { provider: 'gdrive', scope: 'root', label: 'My Drive' },
      diagramAssets: [{ workId: 'd1', title: 'Architecture', mimeType: 'image/png', base64: 'iVBORw0KGgo=' }],
    })
    upstream.lastReadHints = null
    upstream.version = '9'

    await workSync.refreshUpstreamState(withDiagram)

    expect(upstream.lastReadHints?.diagrams).toEqual([{ workId: 'd1', title: 'Architecture' }])
  })
})

describe('unlinkWork', () => {
  test('drops the link without touching the upstream page', async () => {
    await workSync.publishWork(workId, { destination: ENGINEERING })
    upstream.lastPatch = null

    await workSync.unlinkWork(workId)

    expect(await linkOf(workId)).toBeUndefined()
    expect(upstream.lastPatch).toBeNull()
  })
})

describe('importDocFromUrl', () => {
  test('creates a work that is already linked to the page it came from', async () => {
    const imported = await workSync.importDocFromUrl('https://acme.atlassian.net/wiki/spaces/ENG/pages/98765/Spec')

    expect(imported.work.title).toBe('Upstream title')
    const link = await linkOf(imported.work.id)
    expect(link?.externalId).toBe('98765')
    expect(link?.syncState).toBe('ok')
  })
})
