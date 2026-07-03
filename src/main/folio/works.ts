import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createLogger } from '../logger'
import { workPreview } from '../../shared/work-preview'
import { git } from '../git/exec'
import type { AgentId, Work, WorkMeta, WorksManifest, WorkPrevious, WorkStorage } from '../../shared/types'

export type { Work, WorkMeta, WorksManifest, WorkPrevious }

const log = createLogger('folio', 'works.ts')
const LOCAL_ROOT = join(homedir(), '.solus', 'works')
const MANIFEST_FILE = 'works-manifest.json'
const PROJECT_WORKS_DIR = join('.solus', 'works')

type WorkLocator = {
  root: string
  storage: WorkStorage
}

async function ensureDir(root: string): Promise<void> {
  if (!existsSync(root)) {
    await mkdir(root, { recursive: true })
  }
}

function manifestPath(root: string): string {
  return join(root, MANIFEST_FILE)
}

async function readManifest(root: string): Promise<WorksManifest> {
  const path = manifestPath(root)
  if (!existsSync(path)) {
    return { version: 1, works: {} }
  }
  const text = await readFile(path, 'utf8')
  return JSON.parse(text) as WorksManifest
}

async function writeManifest(root: string, manifest: WorksManifest): Promise<void> {
  await ensureDir(root)
  await writeFile(manifestPath(root), JSON.stringify(manifest, null, 2), 'utf8')
}

function contentPath(root: string, id: string): string {
  return join(root, `${id}.json`)
}

function prevPath(root: string, id: string): string {
  return join(root, `${id}.prev.json`)
}

function localLocator(): WorkLocator {
  return { root: LOCAL_ROOT, storage: { kind: 'local' } }
}

function projectLocator(projectRoot: string): WorkLocator {
  const root = join(projectRoot, PROJECT_WORKS_DIR)
  return {
    root,
    storage: { kind: 'project', projectRoot, relativePath: PROJECT_WORKS_DIR },
  }
}

function normalizeStorage(meta: WorkMeta, locator: WorkLocator): WorkMeta {
  return { ...meta, storage: locator.storage.kind === 'project' ? locator.storage : (meta.storage ?? locator.storage) }
}

function manifestMeta(meta: WorkMeta, locator: WorkLocator): WorkMeta {
  if (locator.storage.kind !== 'project') return meta
  return {
    ...meta,
    storage: { kind: 'project', relativePath: PROJECT_WORKS_DIR },
  }
}

function projectRootForCwd(cwd?: string): string | null {
  if (!cwd || cwd === '~') return null
  try {
    return git(['rev-parse', '--show-toplevel'], cwd, { timeout: 5_000 })
  } catch {
    return isAbsolute(cwd) ? cwd : null
  }
}

function assertInsideProject(projectRoot: string, target: string): void {
  const rel = relative(resolve(projectRoot), resolve(target))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes project root: ${target}`)
  }
}

async function findWork(id: string, cwd?: string): Promise<{ locator: WorkLocator; manifest: WorksManifest; meta: WorkMeta } | null> {
  const local = localLocator()
  const localManifest = await readManifest(local.root)
  const localMeta = localManifest.works[id]
  if (localMeta) return { locator: local, manifest: localManifest, meta: normalizeStorage(localMeta, local) }

  const projectRoot = projectRootForCwd(cwd)
  if (!projectRoot) return null
  const project = projectLocator(projectRoot)
  const projectManifest = await readManifest(project.root)
  const projectMeta = projectManifest.works[id]
  if (!projectMeta) return null
  return { locator: project, manifest: projectManifest, meta: normalizeStorage(projectMeta, project) }
}

/** Snapshot the current content as the single "previous version" before an
 *  agent-driven overwrite. Best-effort — never blocks the save. */
async function snapshotPreviousContent(id: string, cwd?: string): Promise<void> {
  try {
    const found = await findWork(id, cwd)
    if (!found) return
    const raw = await readFile(contentPath(found.locator.root, id), 'utf8')
    const { content } = JSON.parse(raw) as { content: string }
    const prev: WorkPrevious = { content, updatedAt: found.meta.updatedAt }
    await writeFile(prevPath(found.locator.root, id), JSON.stringify(prev), 'utf8')
  } catch (err: any) {
    log.warn(`snapshotPreviousContent(${id}) failed: ${String(err)}`)
  }
}

/** Save driven by the agent — snapshots the prior content first so the user can
 *  review "what the agent changed". User-initiated saves go through saveWork and
 *  stay snapshot-free. */
export async function agentSaveWork(
  id: string,
  updates: Partial<Pick<Work, 'title' | 'preview' | 'content'>>,
  cwd?: string
): Promise<Work> {
  if (updates.content !== undefined) await snapshotPreviousContent(id, cwd)
  return saveWork(id, updates, cwd)
}

/** Restore the single previous snapshot as the current content. The swap is
 *  re-invertable: the content being replaced becomes the new snapshot, so a
 *  second revert undoes the first. Returns null when there is nothing to revert
 *  to. */
export async function revertWork(id: string, cwd?: string): Promise<Work | null> {
  const current = await loadWork(id, cwd)
  const prev = await loadWorkPrevious(id, cwd)
  if (!current || !prev) return null
  const found = await findWork(id, cwd)
  if (!found) return null
  const nextPrev: WorkPrevious = { content: current.content, updatedAt: current.updatedAt }
  await writeFile(prevPath(found.locator.root, id), JSON.stringify(nextPrev), 'utf8')
  const preview = workPreview(current.type, prev.content)
  return saveWork(id, { content: prev.content, preview }, cwd)
}

export async function loadWorkPrevious(id: string, cwd?: string): Promise<WorkPrevious | null> {
  try {
    const found = await findWork(id, cwd)
    if (!found) return null
    const file = prevPath(found.locator.root, id)
    if (!existsSync(file)) return null
    return JSON.parse(await readFile(file, 'utf8')) as WorkPrevious
  } catch {
    return null
  }
}

export async function createWork(
  title: string,
  type: 'doc' | 'slides' | 'diagram',
  content: string = '',
  preview: string = '',
  sessionId: string | undefined,
  agentProvider: AgentId,
  cwd: string = '~',
  id: string = randomUUID()
): Promise<Work> {
  const locator = localLocator()
  await ensureDir(locator.root)
  const now = new Date().toISOString()

  const meta: WorkMeta = {
    title,
    preview,
    type,
    createdAt: now,
    updatedAt: now,
    sessionId,
    sessionIds: sessionId ? [sessionId] : [],
    agentProvider,
    cwd,
    storage: locator.storage,
  }

  const manifest = await readManifest(locator.root)
  manifest.works[id] = manifestMeta(meta, locator)
  await writeManifest(locator.root, manifest)
  await writeFile(contentPath(locator.root, id), JSON.stringify({ content }), 'utf8')

  return { id, content, ...meta }
}

export async function duplicateWork(id: string, cwd?: string): Promise<Work> {
  const found = await findWork(id, cwd)
  if (!found) throw new Error(`Work not found: ${id}`)

  const { locator, manifest } = found
  const raw = await readFile(contentPath(locator.root, id), 'utf8')
  const { content } = JSON.parse(raw) as { content: string }
  const duplicateId = randomUUID()
  const now = new Date().toISOString()
  const meta: WorkMeta = {
    ...found.meta,
    title: `${found.meta.title} copy`,
    createdAt: now,
    updatedAt: now,
    sessionId: undefined,
    sessionIds: [],
    pinned: undefined,
  }

  manifest.works[duplicateId] = manifestMeta(meta, locator)
  await writeManifest(locator.root, manifest)
  await writeFile(contentPath(locator.root, duplicateId), JSON.stringify({ content }), 'utf8')

  return { id: duplicateId, content, ...meta }
}

export async function saveWork(
  id: string,
  updates: Partial<Pick<Work, 'title' | 'preview' | 'content'>>,
  cwd?: string
): Promise<Work> {
  const found = await findWork(id, cwd)
  if (!found) throw new Error(`Work not found: ${id}`)
  const { locator, manifest } = found
  const meta = found.meta

  const now = new Date().toISOString()

  if (updates.title !== undefined) meta.title = updates.title
  if (updates.preview !== undefined) meta.preview = updates.preview
  meta.updatedAt = now

  manifest.works[id] = manifestMeta(meta, locator)
  await writeManifest(locator.root, manifest)

  let content: string
  if (updates.content !== undefined) {
    await writeFile(contentPath(locator.root, id), JSON.stringify({ content: updates.content }), 'utf8')
    content = updates.content
  } else {
    const raw = await readFile(contentPath(locator.root, id), 'utf8')
    content = (JSON.parse(raw) as { content: string }).content
  }

  return { id, content, ...meta }
}

export async function loadWork(id: string, cwd?: string): Promise<Work | null> {
  try {
    const found = await findWork(id, cwd)
    if (!found) return null

    const raw = await readFile(contentPath(found.locator.root, id), 'utf8')
    const { content } = JSON.parse(raw) as { content: string }

    return { id, content, ...found.meta }
  } catch (err: any) {
    log.error(`Error loading work ${id}: ${String(err)}`)
    return null
  }
}

export async function listWorks(cwd?: string): Promise<(WorkMeta & { id: string })[]> {
  try {
    const entries: (WorkMeta & { id: string })[] = []
    const local = localLocator()
    const localManifest = await readManifest(local.root)
    entries.push(...Object.entries(localManifest.works).map(([id, meta]) => ({ id, ...normalizeStorage(meta, local) })))

    const projectRoot = projectRootForCwd(cwd)
    if (projectRoot) {
      const project = projectLocator(projectRoot)
      const projectManifest = await readManifest(project.root)
      entries.push(...Object.entries(projectManifest.works).map(([id, meta]) => ({ id, ...normalizeStorage(meta, project) })))
    }

    return entries
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch (err: any) {
    log.error(`Error listing works: ${String(err)}`)
    return []
  }
}

export async function setWorkPinned(id: string, pinned: boolean, cwd?: string): Promise<void> {
  const found = await findWork(id, cwd)
  if (!found) return
  const { locator, manifest, meta } = found
  if (pinned) meta.pinned = true
  else delete meta.pinned
  manifest.works[id] = manifestMeta(meta, locator)
  await writeManifest(locator.root, manifest)
}

export async function linkWorkSession(id: string, sessionId: string, cwd?: string): Promise<void> {
  const found = await findWork(id, cwd)
  if (!found) return
  const { locator, manifest, meta } = found
  const sessionIds = meta.sessionIds ?? (meta.sessionId ? [meta.sessionId] : [])
  if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId)
  meta.sessionIds = sessionIds
  if (!meta.sessionId) meta.sessionId = sessionId
  manifest.works[id] = manifestMeta(meta, locator)
  await writeManifest(locator.root, manifest)
}

/** Permanently remove a work's manifest entry and on-disk files. */
export async function deleteWork(id: string, cwd?: string): Promise<void> {
  const found = await findWork(id, cwd)
  if (!found) throw new Error(`Work not found: ${id}`)
  const { locator, manifest } = found

  delete manifest.works[id]
  await writeManifest(locator.root, manifest)
  await rmWorkFiles(locator.root, id)
}

export async function promoteWorkToProject(id: string, projectRoot: string): Promise<Work> {
  const resolvedRoot = resolve(projectRoot)
  const project = projectLocator(resolvedRoot)
  assertInsideProject(resolvedRoot, project.root)

  const local = localLocator()
  const localManifest = await readManifest(local.root)
  const localMeta = localManifest.works[id]
  if (!localMeta) {
    const existing = await loadWork(id, resolvedRoot)
    if (existing?.storage?.kind === 'project') return existing
    throw new Error(`Work not found: ${id}`)
  }

  const raw = await readFile(contentPath(local.root, id), 'utf8')
  const { content } = JSON.parse(raw) as { content: string }
  const now = new Date().toISOString()
  const meta: WorkMeta = {
    ...localMeta,
    updatedAt: now,
    storage: project.storage,
  }

  const projectManifest = await readManifest(project.root)
  projectManifest.works[id] = manifestMeta(meta, project)
  await writeManifest(project.root, projectManifest)
  await writeFile(contentPath(project.root, id), JSON.stringify({ content }), 'utf8')

  const localPrev = prevPath(local.root, id)
  if (existsSync(localPrev)) {
    await writeFile(prevPath(project.root, id), await readFile(localPrev, 'utf8'), 'utf8')
  }

  delete localManifest.works[id]
  await writeManifest(local.root, localManifest)
  await rmWorkFiles(local.root, id)

  return { id, content, ...meta }
}

async function rmWorkFiles(root: string, id: string): Promise<void> {
  const path = contentPath(root, id)
  if (existsSync(path)) {
    await rm(path)
  }
  const prev = prevPath(root, id)
  if (existsSync(prev)) {
    await rm(prev)
  }
}
