import { describe, expect, mock, test } from 'bun:test'
import type { CopiedProjectFile, IgnoredProjectFile } from '@solus/contracts/types'
import { singleHostServerConnections } from './helpers/server-connections-mock'

mock.module('@solus/client-core/server-connections', () => ({ serverConnections: singleHostServerConnections() }))
const { copiedProjectFiles } = await import('@solus/workspace-ui/components/servers/run-on')
const { includeChanges, initialSelection } = await import('@solus/workspace-ui/components/servers/lib/copied-files')
const { dispatchTo, folderLocation } = await import('@solus/workspace-ui/contexts/workspace/run-location')

const file = (path: string, included = false, byteLength = 10): IgnoredProjectFile => ({ path, byteLength, included })

describe('what the copied files list starts with', () => {
  test('a project with a .worktreeinclude shows exactly what it names', () => {
    // WHY: the boxes are the file. Suggesting more here would make a Save
    // change the file without the person asking.
    const files = [file('.env', false), file('dev.log', true)]
    expect([...initialSelection(files, true)]).toEqual(['dev.log'])
  })

  test('a project without one suggests its env files, and none too large to copy', () => {
    // WHY: env files are what a fresh clone almost always lacks to run.
    const files = [file('.env'), file('apps/site/.dev.vars'), file('.envrc'), file('.env.big', false, 2 * 1024 * 1024), file('dev.log')]
    expect([...initialSelection(files, false)].sort()).toEqual(['.envrc', '.env', 'apps/site/.dev.vars'].sort())
  })

  test('Save writes only the boxes that differ from the file', () => {
    const files = [file('.env', true), file('.env.local', false), file('dev.log', false)]
    expect(includeChanges(files, new Set(['.env.local']))).toEqual([
      { path: '.env', included: false },
      { path: '.env.local', included: true },
    ])
  })
})

describe('the files a Run on send carries', () => {
  const home = { serverId: 'laptop', path: '/Users/dev/solus' }
  const sent: CopiedProjectFile[] = [{ path: '.env', contentBase64: 'QT0x' }]

  test('they are read from the project home, not from the host the run goes to', async () => {
    // WHY: the clone does not exist yet; the files live in the checkout it copies.
    const asked: string[] = []
    const run = { location: dispatchTo(folderLocation(home), 'studio', 'github.com/solus-sh/solus') }
    const files = await copiedProjectFiles(run, (serverId) => ({
      readWorktreeIncludedFiles: async (cwd: string) => {
        asked.push(`${serverId}:${cwd}`)
        return sent
      },
    }))
    expect(asked).toEqual(['laptop:/Users/dev/solus'])
    expect(files).toEqual(sent)
  })

  test('a home host that cannot answer sends no files rather than stopping the send', async () => {
    // WHY: copied files help the run; they must never be the reason it does not start.
    const run = { location: dispatchTo(folderLocation(home), 'studio', 'github.com/solus-sh/solus') }
    const files = await copiedProjectFiles(run, () => ({
      readWorktreeIncludedFiles: async () => { throw new Error('offline') },
    }))
    expect(files).toEqual([])
  })
})
