import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachablePromptPaths, pathsNamedInPrompt, PROMPT_PATH_LIMIT } from '@solus/server/execution/sessions/prompt-paths'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/codebases.md decision 8: one rule says which folder a path names,
// so each trigger attaches the same session folder for the same path. A
// repository is attached as a whole, because review and Git work for a
// repository and not for a part of one.

let root: string
let attachTargetOf: typeof import('@solus/server/execution/sessions/attach-target')['attachTargetOf']
const at = (path: string): string => join(root, path)

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-attach-target-')))
  ;({ attachTargetOf } = await import('@solus/server/execution/sessions/attach-target'))
  // The rule asks Git for the repository of a path; with no caller, it acts as the host.
  ;(await import('@solus/server/execution/seats/acting-identity')).actAsHostForTests()
  const { git } = await import('@solus/server/git/exec')
  mkdirSync(at('repo/packages/app/src'), { recursive: true })
  git(['init', '-b', 'main'], at('repo'))
  writeFileSync(at('repo/packages/app/src/main.ts'), 'export {}\n')
  mkdirSync(at('plain/docs'), { recursive: true })
  writeFileSync(at('plain/docs/notes.md'), 'notes\n')
  symlinkSync(at('repo'), at('link-to-repo'))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('the folder that a path names', () => {
  test('a file or a folder in a repository names the root of the repository', async () => {
    expect(await attachTargetOf(at('repo/packages/app/src/main.ts'))).toEqual({ folder: at('repo') })
    expect(await attachTargetOf(at('repo/packages/app'))).toEqual({ folder: at('repo') })
    expect(await attachTargetOf(at('repo'))).toEqual({ folder: at('repo') })
  })

  test('the root keeps the names of the path, also through a link', async () => {
    // WHY: Git answers the real path. The session folder must have the name that the person or the agent used.
    expect(await attachTargetOf(at('link-to-repo/packages/app/src/main.ts'))).toEqual({ folder: at('link-to-repo') })
  })

  test('a folder with no repository names itself, and a file in it names its directory', async () => {
    expect(await attachTargetOf(at('plain/docs'))).toEqual({ folder: at('plain/docs') })
    expect(await attachTargetOf(at('plain/docs/notes.md'))).toEqual({ folder: at('plain/docs') })
  })

  test('the home directory and the root of the file system are refused', async () => {
    // WHY: they hold much more than one piece of work. An agent that names them gets a message, not a grant.
    expect(await attachTargetOf('/')).toEqual({ refused: expect.stringContaining('root of the file system') })
    expect(await attachTargetOf('~')).toEqual({ refused: expect.stringContaining('home directory') })
    expect(await attachTargetOf(homedir())).toEqual({ refused: expect.stringContaining('home directory') })
  })

  test('a path that is not on this host, and a relative path, are refused', async () => {
    expect(await attachTargetOf(at('nowhere/file.ts'))).toEqual({ refused: expect.stringContaining('does not exist') })
    expect(await attachTargetOf('repo/packages')).toEqual({ refused: expect.stringContaining('not an absolute path') })
  })
})

describe('the paths that a prompt names', () => {
  const named = (text: string, limit?: number): string[] => pathsNamedInPrompt(text, limit).map((each) => each.path)

  test('a path starts with / or ~/ at the start of a word', () => {
    expect(named('Compare /Users/me/shop/api/main.ts with ~/libs/ui and src/local.ts')).toEqual(['/Users/me/shop/api/main.ts', '~/libs/ui'])
  })

  test('quotes keep a path with spaces together, and an attachment line gives its file', () => {
    expect(named('Open "/Users/me/My Projects/site/index.html" and `~/notes/a b.md`\n[Attached file: /tmp/up loads/spec v2.pdf]'))
      .toEqual(['/Users/me/My Projects/site/index.html', '~/notes/a b.md', '/tmp/up loads/spec v2.pdf'])
  })

  test('the punctuation of the sentence and its brackets are not a part of the path', () => {
    expect(named('Look at /srv/app/config.yaml, then (/srv/app/logs). Is it /srv/app/run.sh? See @/srv/app/README.md!'))
      .toEqual(['/srv/app/config.yaml', '/srv/app/logs', '/srv/app/run.sh', '/srv/app/README.md'])
  })

  test('a URL, a relative path, a lone slash, and a comment are not paths', () => {
    expect(named('Fetch https://example.com/a/b and git@host:owner/repo, use a/b or 1/2. // done\n/ and ~/ are too wide.')).toEqual([])
  })

  test('a path is given one time, in the order of the text', () => {
    expect(named('/b/two then "/a/one" then /b/two again')).toEqual(['/b/two', '/a/one'])
  })

  test('only a mention and an attachment line say that the person pointed at the path', () => {
    // WHY: a file path in the text is not a request to work in its folder, so the trigger must know which paths the person pointed at.
    expect(pathsNamedInPrompt('Fix /srv/app/run.sh, see @/srv/app/README.md and @"/srv/my app/notes.md"\n[Attached file: /srv/spec.pdf]')).toEqual([
      { path: '/srv/app/run.sh', explicit: false },
      { path: '/srv/app/README.md', explicit: true },
      { path: '/srv/my app/notes.md', explicit: true },
      { path: '/srv/spec.pdf', explicit: true },
    ])
    expect(pathsNamedInPrompt('/srv/a.ts failed. Open @/srv/a.ts')).toEqual([{ path: '/srv/a.ts', explicit: true }])
  })

  test('a prompt gives a bounded number of candidates', () => {
    // WHY: the caller reads the disk for each candidate, and a pasted log can name hundreds of paths.
    const log = Array.from({ length: 200 }, (_, line) => `at /var/log/app/file-${line}.log`).join('\n')
    expect(named(log).length).toBeLessThan(100)
    expect(named(log, 2)).toEqual(['/var/log/app/file-0.log', '/var/log/app/file-1.log'])
  })

  test('the extraction does not read the disk: a path that does not exist is still a candidate', () => {
    expect(named('/review the plan')).toEqual(['/review'])
  })
})

describe('the paths of a prompt whose folder is attached', () => {
  test('a path in the text attaches only when it names a directory', async () => {
    // WHY: a pasted log names many files. Each one attached its repository before, so a session got folders that nobody asked for.
    const log = `The build failed:\n  at ${at('repo/packages/app/src/main.ts')}:3\n  at ${at('plain/docs/notes.md')}:1\nMake the change in ${at('plain')}.`
    expect(await attachablePromptPaths(log)).toEqual([at('plain')])
  })

  test('a file attaches its folder when the person pointed at it with a mention or an attachment', async () => {
    expect(await attachablePromptPaths(`Read @${at('repo/packages/app/src/main.ts')}\n[Attached file: ${at('plain/docs/notes.md')}]`))
      .toEqual([at('repo/packages/app/src/main.ts'), at('plain/docs/notes.md')])
  })

  test('a path that is not on this host, and an excluded path, attach nothing', async () => {
    expect(await attachablePromptPaths(`Work in ${at('nowhere')} and ${at('plain')}`, (path) => path === at('plain'))).toEqual([])
  })

  test('one prompt attaches the folders of at most three paths, in the order of the text', async () => {
    for (const name of ['one', 'two', 'three', 'four']) mkdirSync(at(`many/${name}`), { recursive: true })
    const prompt = ['one', 'two', 'three', 'four'].map((name) => at(`many/${name}`)).join(' ')
    expect(PROMPT_PATH_LIMIT).toBe(3)
    expect(await attachablePromptPaths(prompt)).toEqual([at('many/one'), at('many/two'), at('many/three')])
  })
})
