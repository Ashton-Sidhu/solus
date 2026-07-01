import { rm } from 'fs/promises'
import { existsSync } from 'fs'
import { homedir } from 'os'
import path, { basename } from 'path'
import type { ProjectEntry } from '../../shared/types'
import { createLogger } from '../logger'
import { listRecentProjects } from '../recent-projects'
import { readJsonOrNull, writeJson } from './json-file'
import { resolveProjectKey } from './project-config'

const log = createLogger('main', 'projects-manifest')

const PROJECTS_DIR = path.join(homedir(), '.solus', 'projects')
const MANIFEST_PATH = path.join(PROJECTS_DIR, 'manifest.json')

interface Manifest {
  version: 1
  projects: ProjectEntry[]
}

function normalize(value: unknown): ProjectEntry[] {
  if (!value || typeof value !== 'object') return []
  const raw = (value as { projects?: unknown }).projects
  if (!Array.isArray(raw)) return []
  const out: ProjectEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const e = item as Partial<ProjectEntry>
    if (typeof e.path !== 'string' || typeof e.key !== 'string') continue
    out.push({
      key: e.key,
      path: e.path,
      folderName: typeof e.folderName === 'string' ? e.folderName : basename(e.path) || e.path,
      addedAt: typeof e.addedAt === 'string' ? e.addedAt : new Date().toISOString(),
    })
  }
  return out
}

async function readManifest(): Promise<ProjectEntry[]> {
  return normalize(await readJsonOrNull(MANIFEST_PATH))
}

async function writeManifest(projects: ProjectEntry[]): Promise<void> {
  const manifest: Manifest = { version: 1, projects }
  await writeJson(MANIFEST_PATH, manifest)
}

/** Add a project to the manifest if not already present (keyed by its config hash). */
export async function recordProject(cwd: string): Promise<void> {
  if (!cwd || cwd === '~') return
  const key = resolveProjectKey(cwd)
  const projects = await readManifest()
  if (projects.some((p) => p.key === key)) return
  projects.push({ key, path: cwd, folderName: basename(cwd) || cwd, addedAt: new Date().toISOString() })
  await writeManifest(projects)
}

/**
 * All known projects. Back-fills the manifest from recent projects so existing
 * users see their history, and drops entries whose folder no longer exists.
 */
export async function listProjects(): Promise<ProjectEntry[]> {
  const manifest = await readManifest()
  const byKey = new Map(manifest.map((p) => [p.key, p]))

  let mutated = false
  const recents = await listRecentProjects()
  for (const r of recents) {
    const key = resolveProjectKey(r.path)
    if (!byKey.has(key)) {
      const entry: ProjectEntry = {
        key,
        path: r.path,
        folderName: r.folderName || basename(r.path) || r.path,
        addedAt: r.lastOpened || new Date().toISOString(),
      }
      byKey.set(key, entry)
      mutated = true
    }
  }

  const present = [...byKey.values()].filter((p) => existsSync(p.path))
  if (mutated || present.length !== manifest.length) {
    await writeManifest(present).catch((err) =>
      log.warn(`failed to persist projects manifest: ${(err as Error).message}`),
    )
  }
  return present.sort((a, b) => a.folderName.localeCompare(b.folderName))
}

/** Remove a project from the manifest and delete its stored per-project data. */
export async function deleteProject(projectPath: string): Promise<void> {
  if (!projectPath) return
  const projects = await readManifest()
  const entry = projects.find((p) => p.path === projectPath)
  const next = projects.filter((p) => p.path !== projectPath)
  await writeManifest(next)
  if (entry) {
    const dir = path.join(PROJECTS_DIR, entry.key)
    await rm(dir, { recursive: true, force: true }).catch((err) =>
      log.warn(`failed to remove project data for ${projectPath}: ${(err as Error).message}`),
    )
  }
}
