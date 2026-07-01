import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import type { RecentProject } from '../shared/types'
import { recordProject } from './project-config/projects-manifest'
import { isWorkspacePath } from './workspace'

const FILE = join(homedir(), '.solus', 'recent-projects.json')
const MAX_PROJECTS = 10

async function ensureDir(): Promise<void> {
  const dir = join(homedir(), '.solus')
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

async function readAll(): Promise<RecentProject[]> {
  try {
    if (!existsSync(FILE)) return []
    const text = await readFile(FILE, 'utf8')
    return JSON.parse(text) as RecentProject[]
  } catch {
    return []
  }
}

async function writeAll(projects: RecentProject[]): Promise<void> {
  await ensureDir()
  await writeFile(FILE, JSON.stringify(projects, null, 2), 'utf8')
}

export async function trackRecentProject(path: string): Promise<void> {
  if (!path || path === '~') return
  // The workspace is the app's default cwd, not a "project" — never log it.
  if (isWorkspacePath(path)) return
  const projects = await readAll()
  const idx = projects.findIndex((p) => p.path === path)
  if (idx !== -1) projects.splice(idx, 1)
  projects.unshift({
    path,
    folderName: basename(path) || path,
    lastOpened: new Date().toISOString(),
  })
  if (projects.length > MAX_PROJECTS) projects.length = MAX_PROJECTS
  await writeAll(projects)
  // Recents are capped; the manifest keeps the full, permanent list.
  await recordProject(path).catch(() => {})
}

export async function listRecentProjects(): Promise<RecentProject[]> {
  const projects = await readAll()
  return projects.filter((p) => existsSync(p.path))
}
