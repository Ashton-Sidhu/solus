import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dataDir } from '../../platform/paths'
import { AppRepositories, type AppFile } from '../app-repository'

/**
 * Where a deployment keeps the builds it received (docs/plans/app-deploy.md
 * §5.1). A deployment has no source and no git: Solus keeps the repository and
 * sends each built version. So the builds here are folders, one for each
 * version, and the Apps service reads them as it reads the build commits of a
 * host's repository. Each other method of a repository is a source method, and
 * a deployment refuses it.
 */

const BUILD_ID = /^[a-f0-9]{40}$/

function assertBuildId(id: string): void {
  if (!BUILD_ID.test(id)) throw new Error('Invalid app build reference.')
}

/** A path a build may hold: relative, with no empty, `.`, or `..` segment. */
function assertFilePath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\0') || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`An app file has a path a build cannot hold: ${path}`)
  }
}

async function filesUnder(folder: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(folder, prefix), { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await filesUnder(folder, path))
    else if (entry.isFile()) files.push(path)
  }
  return files.sort()
}

export class DeploymentBuilds extends AppRepositories {
  constructor(private readonly buildsRoot: () => string = () => join(dataDir(), 'apps', 'builds')) {
    super(buildsRoot)
  }

  private folder(repository: string, build: string): string {
    if (!/^app-[a-f0-9]{48}$/.test(repository)) throw new Error('Invalid app repository name.')
    assertBuildId(build)
    return join(this.buildsRoot(), repository, build)
  }

  /** Keeps the files of one version. The answer names the build: it is the same for the same files of the same version. */
  override async commitBuild(repository: string, build: { number: number; revision: string; files: readonly AppFile[]; at: number }): Promise<string> {
    const hash = createHash('sha256').update(`${build.number}\0`)
    for (const file of [...build.files].sort((a, b) => a.path.localeCompare(b.path))) {
      assertFilePath(file.path)
      hash.update(`${file.path}\0${file.bytes.length}\0`).update(file.bytes)
    }
    const id = hash.digest('hex').slice(0, 40)
    const folder = this.folder(repository, id)
    // Written beside its place and moved there, so a process that stops in between leaves no half build.
    const scratch = `${folder}.incoming`
    await rm(scratch, { recursive: true, force: true })
    for (const file of build.files) {
      const path = join(scratch, file.path)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, file.bytes, { mode: 0o600 })
    }
    await rm(folder, { recursive: true, force: true })
    await rename(scratch, folder)
    return id
  }

  override async readFile(repository: string, commit: string, path: string): Promise<Buffer | null> {
    assertFilePath(path)
    return readFile(join(this.folder(repository, commit), path)).catch(() => null)
  }

  override async listFiles(repository: string, commit: string, folder = ''): Promise<string[]> {
    if (folder) assertFilePath(folder)
    return (await filesUnder(this.folder(repository, commit), folder))
  }

  /** A deployment has no revision: its source is in Solus. */
  override async hasRevision(): Promise<boolean> {
    return false
  }

  override async revisions(): Promise<[]> {
    return []
  }
}
