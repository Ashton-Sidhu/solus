import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One bare origin and an independent code checkout for each Lab host. */
export interface ProjectFixture { origin: string; clone(name: string): string; stop(): void }
export function projectFixture(): ProjectFixture {
  const root = mkdtempSync(join(tmpdir(), 'solus-lab-project-'))
  const origin = join(root, 'origin.git')
  const seed = join(root, 'seed')
  const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  git(['init', '--bare', origin])
  git(['clone', origin, seed])
  writeFileSync(join(seed, 'note.txt'), 'initial\n')
  git(['-C', seed, 'add', 'note.txt'])
  git(['-C', seed, '-c', 'user.name=Lab', '-c', 'user.email=lab@example.invalid', 'commit', '-m', 'Initial project'])
  git(['-C', seed, 'push', 'origin', 'HEAD:main'])
  git(['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  return {
    origin,
    clone(name) {
      const path = join(root, name)
      git(['clone', origin, path])
      return path
    },
    stop() { rmSync(root, { recursive: true, force: true }) },
  }
}
