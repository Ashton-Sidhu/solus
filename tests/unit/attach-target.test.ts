import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
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
let refusalForAutomaticTrigger: typeof import('@solus/server/execution/sessions/attach-target')['refusalForAutomaticTrigger']
let systemTemporaryPlaces: typeof import('@solus/server/execution/sessions/attach-target')['systemTemporaryPlaces']
const at = (path: string): string => join(root, path)
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-attach-target-')))
  // The data folder of Solus for this file: the rule must refuse it, and it must not hold the other folders of the file.
  process.env.SOLUS_DATA_DIR = at('solus-data')
  ;({ attachTargetOf, refusalForAutomaticTrigger, systemTemporaryPlaces } = await import('@solus/server/execution/sessions/attach-target'))
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

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

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

describe('the places that are never a session folder', () => {
  test('the data folder of Solus and the attachment store are refused, also for a request by name', async () => {
    // WHY: the data folder holds the database, the secrets, and the sessions of the host. No agent gets a grant there.
    mkdirSync(at('solus-data/attachments/bucket'), { recursive: true })
    writeFileSync(at('solus-data/attachments/bucket/shot.png'), '')
    mkdirSync(at('solus-data/secrets'), { recursive: true })
    expect(await attachTargetOf(at('solus-data'))).toEqual({ refused: expect.stringContaining('data folder of Solus') })
    expect(await attachTargetOf(at('solus-data/secrets'))).toEqual({ refused: expect.stringContaining('data folder of Solus') })
    expect(await attachTargetOf(at('solus-data/attachments/bucket/shot.png'))).toEqual({ refused: expect.stringContaining('attachment store') })
  })

  test('a task folder and the folder of a chat are folders of work, although they are in the data folder', async () => {
    // WHY: Solus puts the worktrees of a task folder and the folder of each chat in its data folder. A session must still get them.
    mkdirSync(at('solus-data/solus-task-folders/feature-0a1b2c3d/api'), { recursive: true })
    mkdirSync(at('solus-data/solus-chats/chat-1'), { recursive: true })
    expect(await attachTargetOf(at('solus-data/solus-task-folders/feature-0a1b2c3d/api'))).toEqual({ folder: at('solus-data/solus-task-folders/feature-0a1b2c3d/api') })
    expect(await attachTargetOf(at('solus-data/solus-chats/chat-1'))).toEqual({ folder: at('solus-data/solus-chats/chat-1') })
    // The folder that holds all of them is not one piece of work.
    expect(await attachTargetOf(at('solus-data/solus-task-folders'))).toEqual({ refused: expect.stringContaining('data folder of Solus') })
    expect(await attachTargetOf(at('solus-data/solus-chats'))).toEqual({ refused: expect.stringContaining('data folder of Solus') })
  })
})

describe('the rule of an automatic trigger', () => {
  test('a folder in a temporary directory of the system is refused, by its name and by its real path', async () => {
    // WHY: a pasted screenshot is a file in a temporary directory. Its path attached that directory, and a codebase formed from it.
    mkdirSync(at('system-temp/screens'), { recursive: true })
    symlinkSync(at('system-temp'), at('link-to-temp'))
    expect(await refusalForAutomaticTrigger(at('system-temp/screens'), [at('system-temp')])).toContain('temporary directory of the system')
    expect(await refusalForAutomaticTrigger(at('system-temp'), [at('system-temp')])).toContain('temporary directory of the system')
    // The list names the place through a link, as `/tmp` is a link on macOS.
    expect(await refusalForAutomaticTrigger(at('system-temp/screens'), [at('link-to-temp')])).toContain('temporary directory of the system')
    expect(await refusalForAutomaticTrigger(at('plain/docs'), [at('system-temp')])).toBeNull()
  })

  test('the default list has the temporary directory of this machine', async () => {
    // Each folder of this file is in `os.tmpdir()`, on each machine that runs the test.
    expect(systemTemporaryPlaces()).toContain(tmpdir())
    expect(await refusalForAutomaticTrigger(at('plain/docs'), systemTemporaryPlaces())).toContain('temporary directory of the system')
  })

  // The user `root` reads each folder, so the rule cannot be shown for it.
  test.skipIf(process.platform === 'win32' || userInfo().uid === 0)('a folder that cannot be read is refused', async () => {
    mkdirSync(at('locked'))
    chmodSync(at('locked'), 0o000)
    try {
      expect(await refusalForAutomaticTrigger(at('locked'), [])).toContain('cannot be read')
    } finally {
      chmodSync(at('locked'), 0o700)
    }
  })
})

describe('the paths that a prompt names', () => {
  const named = (text: string, limit?: number): string[] => pathsNamedInPrompt(text, limit).map((each) => each.path)

  test('a path starts with / or ~/ at the start of a word', () => {
    expect(named('Compare /Users/me/shop/api/main.ts with ~/libs/ui and src/local.ts')).toEqual(['/Users/me/shop/api/main.ts', '~/libs/ui'])
  })

  test('quotes keep a path with spaces together', () => {
    expect(named('Open "/Users/me/My Projects/site/index.html" and `~/notes/a b.md`'))
      .toEqual(['/Users/me/My Projects/site/index.html', '~/notes/a b.md'])
  })

  test('the path of an attachment is not a path that the prompt names, in each form that a client writes', () => {
    // WHY: the person pasted or dropped a file. The client wrote the path of the place where the system or the host put it.
    expect(named([
      '[Attached image: /var/folders/l_/T/TemporaryItems/NSIRD_screencaptureui_iYi4Yu/Screenshot 1.png]',
      '[Attached file: /tmp/up loads/spec v2.pdf]',
      '[Attached design-selection: ~/captures/selection.png]',
      '[Attached image "shot.png" is saved at: /srv/attachments/shot.png (text extracted to: /srv/attachments/shot.txt)]',
      '[Browser annotation: Header]',
      'Annotated capture: /srv/attachments/bucket/annotated.png',
      '',
      'Why is the header wrong in /srv/app/header.css?',
    ].join('\n'))).toEqual(['/srv/app/header.css'])
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

  test('only a mention says that the person pointed at the path', () => {
    // WHY: a file path in the text is not a request to work in its folder, so the trigger must know which paths the person pointed at.
    expect(pathsNamedInPrompt('Fix /srv/app/run.sh, see @/srv/app/README.md and @"/srv/my app/notes.md"\n[Attached file: /srv/spec.pdf]')).toEqual([
      { path: '/srv/app/run.sh', explicit: false },
      { path: '/srv/app/README.md', explicit: true },
      { path: '/srv/my app/notes.md', explicit: true },
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

  test('a file attaches its folder when the person pointed at it with a mention', async () => {
    expect(await attachablePromptPaths(`Read @${at('repo/packages/app/src/main.ts')} and @"${at('plain/docs/notes.md')}"`))
      .toEqual([at('repo/packages/app/src/main.ts'), at('plain/docs/notes.md')])
  })

  test('an attachment attaches nothing, also when its path names a folder', async () => {
    // WHY: a pasted image is not a request to work in the folder that the system put it in.
    expect(await attachablePromptPaths(`[Attached image: ${at('plain/docs/notes.md')}]\n[Attached file: ${at('plain/docs')}]\n\nWhat is wrong here?`)).toEqual([])
  })

  test('a path that is not on this host attaches nothing', async () => {
    expect(await attachablePromptPaths(`Work in ${at('nowhere')}`)).toEqual([])
  })

  test('one prompt attaches the folders of at most three paths, in the order of the text', async () => {
    for (const name of ['one', 'two', 'three', 'four']) mkdirSync(at(`many/${name}`), { recursive: true })
    const prompt = ['one', 'two', 'three', 'four'].map((name) => at(`many/${name}`)).join(' ')
    expect(PROMPT_PATH_LIMIT).toBe(3)
    expect(await attachablePromptPaths(prompt)).toEqual([at('many/one'), at('many/two'), at('many/three')])
  })
})
