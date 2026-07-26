import { worktreeProjectRoot, type RecentProject } from './types'

function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || trimmed
}

export function canonicalRecentProjects(projects: RecentProject[]): RecentProject[] {
  const seen = new Set<string>()
  const canonical: RecentProject[] = []
  for (const project of projects) {
    const projectPath = worktreeProjectRoot(project.path)
    if (seen.has(projectPath)) continue
    seen.add(projectPath)
    canonical.push({
      ...project,
      path: projectPath,
      folderName: folderName(projectPath),
    })
  }
  return canonical
}
