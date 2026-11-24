import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Codebase, SessionFolder } from '@solus/contracts/codebases'
import { formatAnswer } from '@solus/contracts/question-answer'
import type { AgentId, NormalizedEvent, PermissionMode, PromptOptions, SessionRunInput } from '@solus/contracts/types'
import type { Actor } from '@solus/server/admission/actor'
import type { AgentBackend } from '@solus/server/execution/agents/agent-backend'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
import { git } from '@solus/server/git/exec'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))
// No model names a codebase in this file: a codebase that an attach forms keeps its plain name.
mock.module('@solus/server/execution/agents/writing-backend', () => ({ writingBackendFor: async () => null }))

// docs/plans/codebases.md decision 8: a folder outside the folders of a session
// is attached with no card only in the modes that ask nothing. In each other
// mode a person decides, one time for one folder. An automatic trigger attaches
// only a real project (a Git repository, a project that the host lists), and
// the prompt trigger reads only a prompt that a person wrote. Each rule here
// decides what an agent can reach without a person.

type Runtime = import('@solus/server/execution/session-runtime').SessionRuntime
type Question = Extract<NormalizedEvent, { type: 'question_request' }>
type AttachSession = import('@solus/server/execution/sessions/session-folder-attach').AttachSession

let root: string
let runtimeModule: typeof import('@solus/server/execution/session-runtime')
let folders: typeof import('@solus/server/execution/sessions/session-folders')
let attachRule: typeof import('@solus/server/execution/sessions/session-folder-attach')
let codebases: typeof import('@solus/server/data/codebases/codebases')
let database: typeof import('@solus/server/db')
let HOST_ACTOR: Actor
let installationId: string
const previousDataDir = process.env.SOLUS_DATA_DIR

// The target rule asks Git for the repository of a path; with no caller, it acts as the host.
actAsHostForTests()

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-folder-attach-')))
  process.env.SOLUS_DATA_DIR = join(root, 'data')
  runtimeModule = await import('@solus/server/execution/session-runtime')
  folders = await import('@solus/server/execution/sessions/session-folders')
  attachRule = await import('@solus/server/execution/sessions/session-folder-attach')
  codebases = await import('@solus/server/data/codebases/codebases')
  database = await import('@solus/server/db')
  ;({ HOST_ACTOR } = await import('@solus/server/admission/actor'))
  installationId = (await import('@solus/server/admission/auth')).getInstallationId()

  for (const repository of ['shop/api', 'libs/ui', 'tools/cli']) {
    mkdirSync(join(root, repository, 'src'), { recursive: true })
    git(['init', '-b', 'main'], join(root, repository))
    writeFileSync(join(root, repository, 'src', 'main.ts'), 'export {}\n')
  }
  for (const folder of ['notes', 'scratch', 'drafts', 'designs/specs']) mkdirSync(join(root, folder), { recursive: true })
  writeFileSync(join(root, 'designs', 'specs', 'login.md'), 'login\n')
  // `designs` is a project that this host lists, with no repository. `notes` is a folder that is no project.
  await (await import('@solus/server/project-config/projects-manifest')).recordProject(join(root, 'designs'))
  writeFileSync(join(root, 'notes', 'todo.md'), 'todo\n')
  for (const picture of ['shot.png', 'annotated.png']) writeFileSync(join(root, 'scratch', picture), '')

  // `system-temp` stands in for the temporary directory of the system, and `data` is the data folder of Solus.
  // Each has a folder with no repository and a repository, because the folder of a path is one or the other.
  for (const repository of ['system-temp/clone', 'data/mirror']) {
    mkdirSync(join(root, repository, 'src'), { recursive: true })
    git(['init', '-b', 'main'], join(root, repository))
    writeFileSync(join(root, repository, 'src', 'main.ts'), 'export {}\n')
  }
  for (const folder of ['system-temp/screens', 'data/exports', 'data/attachments/bucket']) mkdirSync(join(root, folder), { recursive: true })
  for (const file of ['system-temp/screens/shot.png', 'data/exports/report.csv', 'data/attachments/bucket/shot.png']) writeFileSync(join(root, file), '')
})

afterAll(() => {
  database.closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

const at = (path: string): string => join(root, path)
const paths = (list: SessionFolder[]): string[] => list.map((folder) => folder.path)

let nextCodebase = 0
async function savedCodebase(localPaths: string[]): Promise<Codebase> {
  return codebases.saveCodebase('local', 'owner', {
    id: `attach-codebase-${++nextCodebase}`,
    name: 'shop',
    roots: [
      // A root with no repository of its own is a container root: the host reads the repositories inside it.
      ...localPaths.map((path) => ({ installationId, path: at(path), name: '', ...(existsSync(join(at(path), '.git')) ? {} : { container: true as const }) })),
      { installationId: 'installation-build-server', path: '/srv/solus-test-infra', name: 'infra' },
    ],
    updatedAt: 1_000,
    deletedAt: null,
  })
}

/** A provider that answers no question itself: only the attach rule can take the answer of its card. */
class QuietBackend extends EventEmitter {
  readonly id: AgentId = 'codex'
  readonly permissions = {
    getPendingInfo: () => undefined,
    respondToPermission: () => false,
    respondToQuestion: () => false,
    clearPendingForSession: () => {},
    setCurrentSessionId: () => {},
  }
  getSessionHandle(): undefined { return undefined }
  cancelSession(): boolean { return false }
  isSessionRunning(): boolean { return false }
  getPendingHandles(): never[] { return [] }
}

interface Live {
  runtime: Runtime
  sessionId: string
  /** The cards the session showed. */
  cards: Question[]
  /** Resolves when the session showed its card number `count`. */
  shown(count: number): Promise<Question>
  /** The channel a tool of the running turn has: the event goes through the provider event path. */
  asker: { emit: (event: NormalizedEvent) => void; signal: AbortSignal }
  stop: AbortController
  answer(card: Question, choice: string): Promise<boolean>
  /** A request by name with a way to show a card, as the `attach_folder` tool makes it. */
  request(path: string): ReturnType<Runtime['sessionFolders']['requestAttach']>
}

/**
 * A session with a running turn in `mode`, in the working directory `shop/api`.
 *
 * Each folder of this file is in the temporary directory of the system, which
 * no automatic trigger attaches. So a session here has no temporary places,
 * and a test of that rule gives `system-temp` (`temporaryPlaces`).
 */
async function liveSession(sessionId: string, mode: PermissionMode, codebaseId?: string, temporaryPlaces: string[] = [], forming?: { workingDirectory: string }): Promise<Live> {
  const backend = new QuietBackend()
  // SAFETY: the test backend has each member that the event path of a question reads.
  const runtime = new runtimeModule.SessionRuntime(new Map([['codex', backend as unknown as AgentBackend]]), { temporaryPlaces })
  const thread = `thread-${sessionId}`
  runtime.agentSessionToSession.set(thread, sessionId)
  runtime.activeSessions.set(sessionId, {
    sessionId, agentSessionId: thread, backendId: 'codex', status: 'running', pendingInputEvents: [],
    lastActivityAt: Date.now(), promptCount: 1, activeTurnId: 'turn-1',
  })
  runtime.sessionPermissionModes.set(sessionId, mode)
  const cards: Question[] = []
  const waiting: (() => void)[] = []
  runtime.on('event', (id: string, event: NormalizedEvent) => {
    if (id !== sessionId || event.type !== 'question_request') return
    cards.push(event)
    for (const wake of waiting.splice(0)) wake()
  })
  const shown = async (count: number): Promise<Question> => {
    while (cards.length < count) await new Promise<void>((wake) => { waiting.push(wake) })
    return cards[count - 1]!
  }
  // These tests are about the attach rule (decision 8). A session with no codebase says "No codebase", so decision 13 makes none from an attach.
  // `forming` is a session that can get a codebase from an attach: it works in its own repository.
  const turn = forming
    ? { workingDirectory: forming.workingDirectory, repositoryRoot: forming.workingDirectory }
    : { workingDirectory: at('shop/api'), codebaseId, noCodebase: !codebaseId }
  await runtime.sessionFolders.resolve(sessionId, { ...turn, actor: HOST_ACTOR })
  const stop = new AbortController()
  const asker = { emit: (event: NormalizedEvent) => { backend.emit('normalized', thread, event) }, signal: stop.signal }
  return {
    runtime, sessionId, cards, shown, asker, stop,
    answer: (card, choice) => runtime.inputRequests.respondToQuestion(sessionId, card.questionId, { [folders.ATTACH_QUESTION_ID]: choice }, HOST_ACTOR),
    request: (path) => runtime.sessionFolders.requestAttach(sessionId, path, 'attached', HOST_ACTOR, { asker, byName: true }),
  }
}

describe('the attach rule in each permission mode', () => {
  for (const mode of ['full-access', 'auto'] as const) {
    test(`${mode} attaches with no card`, async () => {
      const live = await liveSession(`no-card-${mode}`, mode)
      try {
        expect(await live.request(at('notes'))).toEqual({ kind: 'attached', folder: at('notes'), addedToCodebase: false })
        expect(live.cards).toEqual([])
        expect(live.runtime.sessionFolders.grantedPaths(live.sessionId)).toEqual([at('notes')])
      } finally {
        live.runtime.shutdown()
      }
    })
  }

  for (const mode of ['supervised', 'accept-edits', 'plan'] as const) {
    test(`${mode} shows a card, and the folder is attached only after the person allows it`, async () => {
      const live = await liveSession(`card-${mode}`, mode)
      try {
        const pending = live.request(at('notes'))
        const card = await live.shown(1)
        const question = card.questions[0]!
        // A session with no codebase has no "add to the codebase" choice.
        expect(question.options.map((option) => option.label)).toEqual([folders.ATTACH_CHOICE.session, folders.ATTACH_CHOICE.refuse])
        expect(question.question).toContain(at('notes'))
        // The card names the folder. It does not name the mode of the session.
        expect(JSON.stringify(card)).not.toContain(mode)
        expect(card.questionId.startsWith(folders.ATTACH_QUESTION_ID_PREFIX)).toBe(true)
        expect(live.runtime.sessionFolders.foldersOf(live.sessionId)).toEqual([])
        // The card is a pending request of the session, so each client shows it and the session waits.
        expect(live.runtime.inputRequests.pendingInputEventsForSession(live.sessionId)).toEqual([card])

        expect(await live.answer(card, folders.ATTACH_CHOICE.session)).toBe(true)
        expect(await pending).toEqual({ kind: 'attached', folder: at('notes'), addedToCodebase: false })
        expect(paths(live.runtime.sessionFolders.foldersOf(live.sessionId))).toEqual([at('notes')])
        expect(live.runtime.inputRequests.pendingInputEventsForSession(live.sessionId)).toEqual([])
      } finally {
        live.runtime.shutdown()
      }
    })
  }

  test('a caller with no way to show a card attaches nothing in a card mode', async () => {
    const live = await liveSession('no-asker', 'supervised')
    try {
      expect(await live.runtime.sessionFolders.requestAttach(live.sessionId, at('libs/ui'), 'attached', HOST_ACTOR)).toEqual({ kind: 'not-asked', folder: at('libs/ui') })
      expect(live.runtime.sessionFolders.foldersOf(live.sessionId)).toEqual([])
    } finally {
      live.runtime.shutdown()
    }
  })

  test('a path that the session has already needs nothing, in each mode', async () => {
    const live = await liveSession('available', 'supervised')
    try {
      await live.runtime.sessionFolders.attach(live.sessionId, at('libs/ui'), 'attached', HOST_ACTOR)
      expect(await live.request(at('shop/api/src/main.ts'))).toEqual({ kind: 'available', folder: at('shop/api') })
      expect(await live.request(at('libs/ui/src'))).toEqual({ kind: 'available', folder: at('libs/ui') })
      expect(live.cards).toEqual([])
    } finally {
      live.runtime.shutdown()
    }
  })

  test('a file in a repository attaches the root of the repository', async () => {
    const live = await liveSession('repository-root', 'full-access')
    try {
      expect(await live.request(at('libs/ui/src/main.ts'))).toEqual({ kind: 'attached', folder: at('libs/ui'), addedToCodebase: false })
      expect(live.runtime.sessionFolders.foldersOf(live.sessionId)).toMatchObject([{ path: at('libs/ui'), state: 'git', source: 'attached', granted: true }])
    } finally {
      live.runtime.shutdown()
    }
  })

  test('a path that names nothing, and a folder a session cannot have, give a message and no card', async () => {
    const live = await liveSession('invalid', 'supervised')
    try {
      expect(await live.request(at('nowhere/file.ts'))).toMatchObject({ kind: 'invalid', message: expect.stringContaining('does not exist') })
      expect(await live.request('/')).toMatchObject({ kind: 'invalid', message: expect.stringContaining('root of the file system') })
      expect(live.cards).toEqual([])
    } finally {
      live.runtime.shutdown()
    }
  })
})

describe('the choices of the attach card', () => {
  test('a session with a codebase can add the folder to the codebase, as a root on this host', async () => {
    const codebase = await savedCodebase(['libs/ui'])
    const live = await liveSession('add-to-codebase', 'supervised', codebase.id)
    try {
      const pending = live.request(at('tools/cli/src/main.ts'))
      const card = await live.shown(1)
      expect(card.questions[0]!.options.map((option) => option.label)).toEqual([
        folders.ATTACH_CHOICE.session, folders.ATTACH_CHOICE.codebase, folders.ATTACH_CHOICE.refuse,
      ])
      await live.answer(card, folders.ATTACH_CHOICE.codebase)
      expect(await pending).toEqual({ kind: 'attached', folder: at('tools/cli'), addedToCodebase: true })

      const saved = await codebases.getCodebase('local', codebase.id)
      expect(saved?.roots).toContainEqual({ installationId, path: at('tools/cli'), name: '' })
      // WHY: a newer `updatedAt` makes each other host take the copy with the new root.
      expect(saved!.updatedAt).toBeGreaterThan(codebase.updatedAt)
      expect(paths(live.runtime.sessionFolders.foldersOf(live.sessionId))).toContain(at('tools/cli'))
    } finally {
      live.runtime.shutdown()
    }
  })

  test('"Allow for this session" leaves the codebase as it was', async () => {
    const codebase = await savedCodebase(['libs/ui'])
    const live = await liveSession('session-only', 'accept-edits', codebase.id)
    try {
      const pending = live.request(at('notes'))
      await live.answer(await live.shown(1), folders.ATTACH_CHOICE.session)
      expect(await pending).toEqual({ kind: 'attached', folder: at('notes'), addedToCodebase: false })
      expect(await codebases.getCodebase('local', codebase.id)).toEqual(codebase)
    } finally {
      live.runtime.shutdown()
    }
  })

  test('a refusal attaches nothing, and the folder is not asked again before the next turn', async () => {
    const live = await liveSession('refused', 'supervised')
    try {
      const pending = live.request(at('notes'))
      await live.answer(await live.shown(1), folders.ATTACH_CHOICE.refuse)
      expect(await pending).toEqual({ kind: 'refused', folder: at('notes') })
      // A second request in the same turn gets the refusal with no second card. A file in the folder names the same folder.
      expect(await live.request(at('notes/todo.md'))).toEqual({ kind: 'refused', folder: at('notes') })
      expect(live.cards).toHaveLength(1)
      expect(live.runtime.sessionFolders.foldersOf(live.sessionId)).toEqual([])
      // A different folder is a different card.
      const other = live.request(at('scratch'))
      await live.answer(await live.shown(2), folders.ATTACH_CHOICE.session)
      expect((await other).kind).toBe('attached')

      // The next turn can ask again.
      await live.runtime.sessionFolders.resolve(live.sessionId, { workingDirectory: at('shop/api'), actor: HOST_ACTOR })
      const again = live.request(at('notes'))
      await live.answer(await live.shown(3), folders.ATTACH_CHOICE.session)
      expect((await again).kind).toBe('attached')
    } finally {
      live.runtime.shutdown()
    }
  })

  test('an answer that is not a choice of the card is a refusal', async () => {
    const live = await liveSession('other-answer', 'supervised')
    try {
      const pending = live.request(at('notes'))
      await live.answer(await live.shown(1), 'attach all of my disk')
      expect((await pending).kind).toBe('refused')
    } finally {
      live.runtime.shutdown()
    }
  })

  // A request finds the folder of its path with Git before it reaches the
  // card, so the order of two requests at the card is not the order of their
  // calls. Each order must give one card: a request that comes after the
  // answer finds the folder that the answer attached.
  test('requests for one folder show one card, in each order of their arrival', async () => {
    const live = await liveSession('shared-card', 'supervised')
    try {
      const first = live.request(at('libs/ui/src/main.ts'))
      // The one request so far opened the card.
      const card = await live.shown(1)
      // These two can reach the card before the answer or after it.
      const second = live.request(at('libs/ui'))
      const third = live.request(at('libs/ui/src'))
      await live.answer(card, folders.ATTACH_CHOICE.session)

      expect(await first).toEqual({ kind: 'attached', folder: at('libs/ui'), addedToCodebase: false })
      for (const outcome of await Promise.all([second, third])) {
        expect(['attached', 'available']).toContain(outcome.kind)
        expect(outcome).toMatchObject({ folder: at('libs/ui') })
      }
      expect(live.cards).toHaveLength(1)
      expect(paths(live.runtime.sessionFolders.foldersOf(live.sessionId))).toEqual([at('libs/ui')])
    } finally {
      live.runtime.shutdown()
    }
  })

  // Two tool calls of one turn name the same repository at the same time. The
  // person answers one time, and the folder is attached one time.
  test('each request that is at the card when the answer comes gets that answer', async () => {
    const live = await liveSession('joined-card', 'supervised')
    try {
      // The rule reads `grantedHolderOf` with no wait before it looks for an
      // open card, so each call says that one more request is at the card.
      let atCard = 0
      const waiting: (() => void)[] = []
      const attachedFolders: string[] = []
      const session: AttachSession = {
        sessionId: live.sessionId,
        state: { codebaseId: null, codebase: null, openCards: new Map(), refused: new Set() },
        mode: 'supervised',
        temporaryPlaces: [],
        refresh: async () => {},
        holderOf: async () => null,
        grantedHolderOf: () => {
          atCard++
          for (const wake of waiting.splice(0)) wake()
          return null
        },
        attach: async (folder) => { attachedFolders.push(folder) },
        standInFor: async () => null,
        formationOf: async () => null,
      }
      const requests = ['libs/ui/src/main.ts', 'libs/ui', 'libs/ui/src']
        .map((path) => attachRule.requestAttach(session, at(path), 'attached', HOST_ACTOR, { asker: live.asker }))
      while (atCard < requests.length) await new Promise<void>((wake) => { waiting.push(wake) })
      expect(live.cards).toHaveLength(1)

      await live.answer(live.cards[0]!, folders.ATTACH_CHOICE.session)
      const attached = { kind: 'attached', folder: at('libs/ui'), addedToCodebase: false }
      expect(await Promise.all(requests)).toEqual([attached, attached, attached])
      expect(attachedFolders).toEqual([at('libs/ui')])
      expect(live.cards).toHaveLength(1)
    } finally {
      live.runtime.shutdown()
    }
  })

  test('a turn that stops before the answer attaches nothing and remembers no refusal', async () => {
    const live = await liveSession('stopped', 'supervised')
    try {
      const pending = live.request(at('notes'))
      await live.shown(1)
      live.stop.abort()
      expect(await pending).toEqual({ kind: 'not-asked', folder: at('notes') })
      expect(live.runtime.sessionFolders.foldersOf(live.sessionId)).toEqual([])
    } finally {
      live.runtime.shutdown()
    }
  })
})

describe('the card of an attach that forms a codebase', () => {
  /** A repository with one file. */
  function repositoryAt(name: string): string {
    mkdirSync(at(join(name, 'src')), { recursive: true })
    git(['init', '-b', 'main'], at(name))
    writeFileSync(at(join(name, 'src', 'main.ts')), 'export {}\n')
    return at(name)
  }

  /** A session with no codebase in a new repository `<name>`, and a second project `<name>-api` that it can attach. */
  async function formingSession(name: string): Promise<{ live: Live; project: string; second: string }> {
    const project = repositoryAt(name)
    const second = repositoryAt(`${name}-api`)
    return { live: await liveSession(`forms-${name}`, 'supervised', undefined, [], { workingDirectory: project }), project, second }
  }

  const codebasesAt = async (path: string): Promise<Codebase[]> => (await codebases.listCodebases('local')).filter((codebase) => codebase.roots.some((each) => each.path === path))

  test('the card says that a codebase is made, shows its name, and has three choices', async () => {
    // WHY: an attach of a real second project changes each later session of the project. The person must see that, and can name it.
    const { live, project, second } = await formingSession('orchid')
    try {
      const pending = live.request(join(second, 'src', 'main.ts'))
      const card = await live.shown(1)
      const [question] = card.questions
      expect(question!.question).toContain('makes the codebase "orchid"')
      expect(question!.options.map((option) => option.label)).toEqual([
        folders.ATTACH_CHOICE.make, folders.ATTACH_CHOICE.sessionOnly, folders.ATTACH_CHOICE.refuse,
      ])
      expect(question!.options[0]!.description).toContain('"orchid"')

      await live.answer(card, folders.ATTACH_CHOICE.make)
      expect(await pending).toEqual({ kind: 'attached', folder: second, addedToCodebase: false })
      expect(await codebasesAt(project)).toMatchObject([{ name: 'orchid', roots: [{ path: project }, { path: second }] }])
      expect(live.runtime.sessionFolders.foldersOf(live.sessionId)).toMatchObject([{ path: second, source: 'codebase' }])
    } finally {
      live.runtime.shutdown()
    }
  })

  test('a name that the person types in the answer field is the name of the codebase', async () => {
    const { live, project } = await formingSession('tulip')
    try {
      const pending = live.request(at('tulip-api'))
      // The card of each client sends the choice and the typed words as one answer.
      await live.answer(await live.shown(1), formatAnswer(folders.ATTACH_CHOICE.make, '  Tulip stack '))
      expect((await pending).kind).toBe('attached')
      expect((await codebasesAt(project)).map((codebase) => codebase.name)).toEqual(['Tulip stack'])
    } finally {
      live.runtime.shutdown()
    }
  })

  test('"Allow for this session only" attaches the folder and makes no codebase', async () => {
    const { live, project, second } = await formingSession('dahlia')
    try {
      const pending = live.request(second)
      await live.answer(await live.shown(1), folders.ATTACH_CHOICE.sessionOnly)
      expect(await pending).toEqual({ kind: 'attached', folder: second, addedToCodebase: false })
      expect(await codebasesAt(project)).toEqual([])
      expect(live.runtime.sessionFolders.foldersOf(live.sessionId)).toMatchObject([{ path: second, source: 'attached' }])
    } finally {
      live.runtime.shutdown()
    }
  })

  test('"Do not allow" attaches nothing and makes no codebase', async () => {
    const { live, project, second } = await formingSession('peony')
    try {
      const pending = live.request(second)
      await live.answer(await live.shown(1), folders.ATTACH_CHOICE.refuse)
      expect(await pending).toEqual({ kind: 'refused', folder: second })
      expect(await codebasesAt(project)).toEqual([])
      expect(live.runtime.sessionFolders.foldersOf(live.sessionId)).toEqual([])
    } finally {
      live.runtime.shutdown()
    }
  })

  test('a folder that is no second project gets the card of a session folder', async () => {
    // WHY: a folder of notes forms no codebase (decision 13), so the card must not say that one is made.
    const { live, project } = await formingSession('zinnia')
    try {
      const pending = live.request(at('notes'))
      const card = await live.shown(1)
      expect(card.questions[0]!.question).not.toContain('codebase')
      expect(card.questions[0]!.options.map((option) => option.label)).toEqual([folders.ATTACH_CHOICE.session, folders.ATTACH_CHOICE.refuse])
      await live.answer(card, folders.ATTACH_CHOICE.session)
      expect((await pending).kind).toBe('attached')
      expect(await codebasesAt(project)).toEqual([])
    } finally {
      live.runtime.shutdown()
    }
  })

  test('the answer of the card is its choice, then the typed words', () => {
    // WHY: one label starts with a different one. The longer label must win, or "for this session only" reads as "for this session" with a name.
    expect(attachRule.attachAnswerOf(folders.ATTACH_CHOICE.sessionOnly)).toEqual({ choice: folders.ATTACH_CHOICE.sessionOnly, typed: '' })
    expect(attachRule.attachAnswerOf(`${folders.ATTACH_CHOICE.make} — Shop`)).toEqual({ choice: folders.ATTACH_CHOICE.make, typed: 'Shop' })
    expect(attachRule.attachAnswerOf('Shop')).toEqual({ choice: null, typed: '' })
  })
})

describe('the codebase of the session', () => {
  test('a member on this host needs no card in each mode', async () => {
    for (const mode of ['supervised', 'accept-edits', 'plan', 'auto', 'full-access'] as const) {
      const late = `late-${mode}`
      // The root is not on the disk at the turn start, so it is not a folder of the session yet.
      const codebase = await savedCodebase(['libs/ui', late])
      const live = await liveSession(`member-${mode}`, mode, codebase.id)
      try {
        expect(paths(live.runtime.sessionFolders.foldersOf(live.sessionId))).toEqual([at('libs/ui')])
        mkdirSync(at(late))
        expect(await live.request(at(late))).toEqual({ kind: 'attached', folder: at(late), addedToCodebase: false })
        expect(live.cards).toEqual([])
        expect(live.runtime.sessionFolders.foldersOf(live.sessionId)).toContainEqual(
          { path: at(late), name: late, state: 'plain', repositoryPath: at(late), source: 'codebase', granted: true },
        )
      } finally {
        live.runtime.shutdown()
      }
    }
  })

  test('a path in a root on a different host is not attached: the answer names the host and the path', async () => {
    const codebase = await savedCodebase(['libs/ui'])
    const live = await liveSession('other-host', 'full-access', codebase.id)
    try {
      // This host does not know a host with that installation id, so the id is its label.
      expect(await live.request('/srv/solus-test-infra/modules/main.tf')).toEqual({
        kind: 'other-host', host: 'installation-build-server', path: '/srv/solus-test-infra/modules/main.tf',
      })
      expect(paths(live.runtime.sessionFolders.foldersOf(live.sessionId))).toEqual([at('libs/ui')])
    } finally {
      live.runtime.shutdown()
    }
  })
})

describe('the attach_folder tool', () => {
  const toolContext = (live: Live, provider: AgentId): AgentToolContext => ({
    provider, cwd: at('shop/api'), sessionId: () => live.sessionId, abortSignal: live.stop.signal, parentToolUseId: () => undefined, emit: live.asker.emit,
  })

  test('says in plain words what happened', async () => {
    const tools = await import('@solus/server/execution/agents/tools/folder-tools')
    const codebase = await savedCodebase(['libs/ui'])
    const live = await liveSession('tool', 'supervised', codebase.id)
    tools.setFolderToolHost(live.runtime.sessionFolders, () => HOST_ACTOR)
    try {
      const tool = tools.attachFolderAgentTool
      // The approval gate of the provider must not ask: the attach rule shows its own card.
      expect(tool.requiresApproval).toBe(false)

      const refused = tool.execute({ path: at('notes/todo.md') }, toolContext(live, 'claude-code'))
      await live.answer(await live.shown(1), folders.ATTACH_CHOICE.refuse)
      expect(await refused).toEqual({ ok: false, text: expect.stringContaining(`The person refused to attach "${at('notes')}"`) })

      const attached = tool.execute({ path: at('tools/cli/src/main.ts') }, toolContext(live, 'codex'))
      await live.answer(await live.shown(2), folders.ATTACH_CHOICE.session)
      const result = await attached
      expect(result.ok).toBe(true)
      // The answer names the folder that was attached: the repository root above the path.
      expect(result.text).toContain(`Attached "${at('tools/cli')}"`)
      // Codex gets its writable folders at a turn start.
      expect(result.text).toContain('from the next turn')

      expect(await tool.execute({ path: at('tools/cli/src') }, toolContext(live, 'claude-code')))
        .toEqual({ ok: true, text: expect.stringContaining('already available') })
      const remote = await tool.execute({ path: '/srv/solus-test-infra/main.tf' }, toolContext(live, 'claude-code'))
      expect(remote.ok).toBe(false)
      expect(remote.text).toContain('start_sessions')
      expect(remote.text).toContain('installation-build-server')
      expect(remote.text).toContain('/srv/solus-test-infra/main.tf')
      expect((await tool.execute({ path: 'relative/path' }, toolContext(live, 'claude-code'))).ok).toBe(false)
    } finally {
      tools.setFolderToolHost(null, null)
      live.runtime.shutdown()
    }
  })

  test('is a session tool, so the prompt block tells the agent to call it', async () => {
    const { solusToolbox } = await import('@solus/server/execution/agents/tools/solus-toolbox')
    const { runtimeInstructions } = await import('@solus/server/execution/agents/runtime-instructions')
    const codebase = await savedCodebase(['libs/ui'])
    const live = await liveSession('prompt-block', 'supervised', codebase.id)
    try {
      const instructions = runtimeInstructions(
        { harness: 'Codex', model: 'model-test', reasoningEffort: 'medium', workingDirectory: at('shop/api'), codebase: live.runtime.sessionFolders.promptFolders(live.sessionId) },
        Object.values(solusToolbox.sessions),
      )
      expect(instructions).toContain('To work in a folder that is not listed, call attach_folder first.')
    } finally {
      live.runtime.shutdown()
    }
  })
})

describe('what a provider adapter asks (SessionFolderGate)', () => {
  test('a granted folder holds its paths, and the rule with no card attaches only when the mode asks nothing', async () => {
    const supervised = await liveSession('gate-supervised', 'supervised')
    try {
      const gate = supervised.runtime.sessionFolders
      expect(gate.modeOf(supervised.sessionId)).toBe('supervised')
      expect(await gate.attachUnasked(supervised.sessionId, at('libs/ui/src/main.ts'))).toBeNull()
      expect(gate.grantedFolderOf(supervised.sessionId, at('libs/ui/src/main.ts'))).toBeNull()
      expect(supervised.cards).toEqual([])
    } finally {
      supervised.runtime.shutdown()
    }
    const auto = await liveSession('gate-auto', 'auto')
    try {
      const gate = auto.runtime.sessionFolders
      expect(await gate.attachUnasked(auto.sessionId, at('libs/ui/src/main.ts'))).toBe(at('libs/ui'))
      expect(gate.grantedFolderOf(auto.sessionId, at('libs/ui/src/main.ts'))).toBe(at('libs/ui'))
      expect(gate.grantedFolderOf(auto.sessionId, at('libs/other'))).toBeNull()
    } finally {
      auto.runtime.shutdown()
    }
  })

  test('a request that a person allowed for the session attaches the folder of each path one time', async () => {
    const live = await liveSession('gate-allowed', 'supervised')
    try {
      const published: string[][] = []
      const attached = new Promise<void>((done) => {
        live.runtime.on('event', (id: string, event: NormalizedEvent) => {
          if (id !== live.sessionId || event.type !== 'session_folders') return
          published.push(paths(event.folders))
          done()
        })
      })
      // Two files of one repository, and a file in the working directory.
      live.runtime.sessionFolders.attachAllowed(live.sessionId, [at('libs/ui/src/main.ts'), at('libs/ui/README.md'), at('shop/api/src/main.ts')])
      await attached
      expect(published).toEqual([[at('libs/ui')]])
      expect(live.runtime.sessionFolders.foldersOf(live.sessionId)).toMatchObject([{ path: at('libs/ui'), source: 'attached', granted: true }])
      expect(live.cards).toEqual([])
    } finally {
      live.runtime.shutdown()
    }
  })
})

describe('a path that is in no project', () => {
  // WHY: a read of `~/Downloads/a.pdf` in Auto attached the full folder of downloads, and a read of `~/.ssh/config`
  // attached `~/.ssh`. One blocked path is not a request to work in its folder. The permission flow of the provider
  // answers for that one call, as it did before session folders.
  test('a blocked path in `auto` (attachUnasked) attaches nothing, so the provider shows its permission card', async () => {
    const live = await liveSession('plain-unasked', 'auto')
    try {
      const gate = live.runtime.sessionFolders
      expect(await gate.attachUnasked(live.sessionId, at('notes/todo.md'))).toBeNull()
      expect(await gate.attachUnasked(live.sessionId, at('drafts'))).toBeNull()
      expect(gate.foldersOf(live.sessionId)).toEqual([])
      // A file in a project that the host lists attaches the project, not the folder of the file.
      expect(await gate.attachUnasked(live.sessionId, at('designs/specs/login.md'))).toBe(at('designs'))
      expect(paths(gate.foldersOf(live.sessionId))).toEqual([at('designs')])
    } finally {
      live.runtime.shutdown()
    }
  })

  test('"Allow for session" and an observed write attach nothing there', async () => {
    const live = await liveSession('plain-allowed', 'supervised')
    try {
      const { sessionFolders } = live.runtime
      const attached = new Promise<string[]>((done) => {
        live.runtime.on('event', (id: string, event: NormalizedEvent) => {
          if (id === live.sessionId && event.type === 'session_folders') done(paths(event.folders))
        })
      })
      // The paths are read in their order: only the last one is in a project.
      sessionFolders.attachAllowed(live.sessionId, [at('notes/todo.md'), at('drafts/a.md'), at('libs/ui/src/main.ts')])
      expect(await attached).toEqual([at('libs/ui')])
      sessionFolders.observe(live.sessionId, { type: 'tool_call', toolName: 'Write', toolId: 'write-1', index: 0, toolInput: JSON.stringify({ file_path: at('notes/todo.md'), content: '' }) })
      await sessionFolders.attachObserved(live.sessionId)
      expect(paths(sessionFolders.foldersOf(live.sessionId))).toEqual([at('libs/ui')])
    } finally {
      live.runtime.shutdown()
    }
  })
})

describe('a folder that a tool wrote in', () => {
  test('a repository outside the folders of the session is shown for review, and the provider gets no grant', async () => {
    const live = await liveSession('observed', 'full-access')
    try {
      const { sessionFolders } = live.runtime
      // Claude: the input of an edit comes when its content block ends.
      sessionFolders.observe(live.sessionId, { type: 'tool_call', toolName: 'Edit', toolId: 'edit-1', index: 1 })
      sessionFolders.observe(live.sessionId, { type: 'tool_call_complete', index: 1, toolInput: JSON.stringify({ file_path: at('libs/ui/src/main.ts'), old_string: 'a', new_string: 'b' }) })
      // Codex: a patch names each file in its changes.
      sessionFolders.observe(live.sessionId, { type: 'tool_call', toolName: 'Edit', toolId: 'patch-1', index: 0, toolInput: JSON.stringify({ changes: [{ path: at('tools/cli/src/main.ts'), kind: { type: 'update' }, diff: '' }] }) })
      // A write in the working directory, a write in a folder with no repository, and a read are not observed folders.
      sessionFolders.observe(live.sessionId, { type: 'tool_call', toolName: 'Write', toolId: 'write-1', index: 2, toolInput: JSON.stringify({ file_path: at('shop/api/src/new.ts'), content: '' }) })
      sessionFolders.observe(live.sessionId, { type: 'tool_call', toolName: 'Write', toolId: 'write-2', index: 3, toolInput: JSON.stringify({ file_path: at('notes/todo.md'), content: '' }) })
      sessionFolders.observe(live.sessionId, { type: 'tool_call', toolName: 'Read', toolId: 'read-1', index: 4 })
      sessionFolders.observe(live.sessionId, { type: 'tool_call_complete', index: 4, toolInput: JSON.stringify({ file_path: at('drafts/a.md') }) })
      expect(sessionFolders.foldersOf(live.sessionId)).toEqual([])

      await sessionFolders.attachObserved(live.sessionId)
      expect(sessionFolders.foldersOf(live.sessionId)).toEqual([
        { path: at('libs/ui'), name: 'ui', state: 'git', repositoryPath: at('libs/ui'), source: 'observed', granted: false },
        { path: at('tools/cli'), name: 'cli', state: 'git', repositoryPath: at('tools/cli'), source: 'observed', granted: false },
      ])
      expect(sessionFolders.grantedPaths(live.sessionId)).toEqual([])
      expect(live.cards).toEqual([])
      // The turn end read the writes: a second turn end adds nothing.
      await sessionFolders.detach(live.sessionId, at('tools/cli'), HOST_ACTOR)
      await sessionFolders.attachObserved(live.sessionId)
      expect(paths(sessionFolders.foldersOf(live.sessionId))).toEqual([at('libs/ui')])

      // A person, or the rule, can make an observed folder a granted folder.
      expect(await live.request(at('libs/ui'))).toEqual({ kind: 'attached', folder: at('libs/ui'), addedToCodebase: false })
      expect(sessionFolders.grantedPaths(live.sessionId)).toEqual([at('libs/ui')])
    } finally {
      live.runtime.shutdown()
    }
  })
})

describe('a place that no automatic trigger attaches', () => {
  // WHY: a pasted screenshot is a file in a temporary directory of the system. Its path attached that directory to the
  // session, and a codebase formed from it. A path that Solus only read is not a request to work in such a place.
  const temporaryPlaces = (): string[] => [at('system-temp')]

  test('a blocked path in `auto` (attachUnasked) gets no temporary directory and no data of Solus', async () => {
    const live = await liveSession('refused-unasked', 'auto', undefined, temporaryPlaces())
    try {
      const gate = live.runtime.sessionFolders
      expect(await gate.attachUnasked(live.sessionId, at('system-temp/screens/shot.png'))).toBeNull()
      expect(await gate.attachUnasked(live.sessionId, at('system-temp/clone/src/main.ts'))).toBeNull()
      expect(await gate.attachUnasked(live.sessionId, at('data/exports/report.csv'))).toBeNull()
      expect(await gate.attachUnasked(live.sessionId, at('data/mirror/src/main.ts'))).toBeNull()
      expect(await gate.attachUnasked(live.sessionId, at('data/attachments/bucket/shot.png'))).toBeNull()
      // The same trigger still attaches a folder of the work.
      expect(await gate.attachUnasked(live.sessionId, at('libs/ui/src/main.ts'))).toBe(at('libs/ui'))
      expect(paths(gate.foldersOf(live.sessionId))).toEqual([at('libs/ui')])
    } finally {
      live.runtime.shutdown()
    }
  })

  test('a request that a person allowed for the session (attachAllowed) gets none of them', async () => {
    // WHY: "Allow for session" on a read of a file in `/tmp` allows the read. It does not make `/tmp` a folder of the session.
    const live = await liveSession('refused-allowed', 'supervised', undefined, temporaryPlaces())
    try {
      const published: string[][] = []
      const attached = new Promise<void>((done) => {
        live.runtime.on('event', (id: string, event: NormalizedEvent) => {
          if (id !== live.sessionId || event.type !== 'session_folders') return
          published.push(paths(event.folders))
          done()
        })
      })
      // The paths are read in their order: the last one is a folder of the work, and it is the only one attached.
      live.runtime.sessionFolders.attachAllowed(live.sessionId, [
        at('system-temp/screens/shot.png'), at('system-temp/clone/src/main.ts'), at('data/exports/report.csv'), at('data/mirror/src/main.ts'), at('libs/ui/src/main.ts'),
      ])
      await attached
      expect(published).toEqual([[at('libs/ui')]])
    } finally {
      live.runtime.shutdown()
    }
  })

  test('a write of a tool (attachObserved) shows none of them', async () => {
    const live = await liveSession('refused-observed', 'full-access', undefined, temporaryPlaces())
    try {
      const { sessionFolders } = live.runtime
      for (const [index, file] of [at('system-temp/clone/src/main.ts'), at('data/mirror/src/main.ts'), at('libs/ui/src/main.ts')].entries()) {
        sessionFolders.observe(live.sessionId, { type: 'tool_call', toolName: 'Write', toolId: `write-${index}`, index, toolInput: JSON.stringify({ file_path: file, content: '' }) })
      }
      await sessionFolders.attachObserved(live.sessionId)
      expect(sessionFolders.foldersOf(live.sessionId).map(({ path, source }) => ({ path, source }))).toEqual([{ path: at('libs/ui'), source: 'observed' }])
    } finally {
      live.runtime.shutdown()
    }
  })

  test('the agent and a person can ask for a temporary directory by its name, and get no data of Solus', async () => {
    // WHY: a person or the agent who names a folder made a request. The data folder holds the database and the secrets of the host.
    const tools = await import('@solus/server/execution/agents/tools/folder-tools')
    const live = await liveSession('by-name', 'full-access', undefined, temporaryPlaces())
    tools.setFolderToolHost(live.runtime.sessionFolders, () => HOST_ACTOR)
    const context: AgentToolContext = {
      provider: 'claude-code', cwd: at('shop/api'), sessionId: () => live.sessionId, abortSignal: live.stop.signal, parentToolUseId: () => undefined, emit: live.asker.emit,
    }
    try {
      const tool = tools.attachFolderAgentTool
      expect(await tool.execute({ path: at('data/exports') }, context)).toEqual({ ok: false, text: expect.stringContaining('data folder of Solus') })
      expect(await tool.execute({ path: at('data/mirror/src/main.ts') }, context)).toEqual({ ok: false, text: expect.stringContaining('data folder of Solus') })
      expect(await tool.execute({ path: at('data/attachments/bucket/shot.png') }, context)).toEqual({ ok: false, text: expect.stringContaining('attachment store') })
      expect(await tool.execute({ path: at('system-temp/clone/src/main.ts') }, context)).toEqual({ ok: true, text: expect.stringContaining(`Attached "${at('system-temp/clone')}"`) })

      // A person's own `sessionAttachFolder` calls `attach`.
      const { sessionFolders } = live.runtime
      await expect(sessionFolders.attach(live.sessionId, at('data/exports'), 'attached', HOST_ACTOR)).rejects.toThrow('data folder of Solus')
      await expect(sessionFolders.attach(live.sessionId, at('data/attachments/bucket'), 'attached', HOST_ACTOR)).rejects.toThrow('attachment store')
      expect(paths(await sessionFolders.attach(live.sessionId, at('system-temp/screens'), 'attached', HOST_ACTOR))).toEqual([at('system-temp/clone'), at('system-temp/screens')])
    } finally {
      tools.setFolderToolHost(null, null)
      live.runtime.shutdown()
    }
  })
})

describe('a folder that a project tool made', () => {
  test('becomes a root of the codebase and a folder of the session', async () => {
    const codebase = await savedCodebase(['libs/ui'])
    const live = await liveSession('created', 'supervised', codebase.id)
    try {
      mkdirSync(at('created-site'))
      expect(await live.runtime.sessionFolders.adoptCreated(live.sessionId, at('created-site'), true, HOST_ACTOR)).toEqual({ addedToCodebase: true })
      expect((await codebases.getCodebase('local', codebase.id))?.roots).toContainEqual({ installationId, path: at('created-site'), name: '' })
      expect(live.runtime.sessionFolders.foldersOf(live.sessionId)).toContainEqual(
        { path: at('created-site'), name: 'created-site', state: 'plain', repositoryPath: at('created-site'), source: 'created', granted: true },
      )
      // The tool call was approved: the folder needs no card.
      expect(live.cards).toEqual([])
    } finally {
      live.runtime.shutdown()
    }
  })

  test('with add_to_codebase false, and in a session with no codebase, it is only attached', async () => {
    const codebase = await savedCodebase(['libs/ui'])
    const optedOut = await liveSession('created-opt-out', 'supervised', codebase.id)
    try {
      mkdirSync(at('created-private'))
      expect(await optedOut.runtime.sessionFolders.adoptCreated(optedOut.sessionId, at('created-private'), false, HOST_ACTOR)).toEqual({ addedToCodebase: false })
      expect(await codebases.getCodebase('local', codebase.id)).toEqual(codebase)
      expect(paths(optedOut.runtime.sessionFolders.foldersOf(optedOut.sessionId))).toEqual([at('created-private'), at('libs/ui')])
    } finally {
      optedOut.runtime.shutdown()
    }
    const plain = await liveSession('created-no-codebase', 'supervised')
    try {
      expect(await plain.runtime.sessionFolders.adoptCreated(plain.sessionId, at('created-private'), true, HOST_ACTOR)).toEqual({ addedToCodebase: false })
      expect(plain.runtime.sessionFolders.foldersOf(plain.sessionId)).toMatchObject([{ path: at('created-private'), source: 'created' }])
    } finally {
      plain.runtime.shutdown()
    }
  })

  test('a folder inside a root adds no root: the read of the members gives it', async () => {
    mkdirSync(at('umbrella'))
    const codebase = await savedCodebase(['umbrella'])
    const live = await liveSession('created-in-root', 'supervised', codebase.id)
    try {
      mkdirSync(at('umbrella/service'))
      git(['init', '-b', 'main'], at('umbrella/service'))
      expect(await live.runtime.sessionFolders.adoptCreated(live.sessionId, at('umbrella/service'), true, HOST_ACTOR)).toEqual({ addedToCodebase: false })
      expect(await codebases.getCodebase('local', codebase.id)).toEqual(codebase)
      // The new repository is a member of the codebase now, so it has its own Git status and checkpoint.
      expect(live.runtime.sessionFolders.foldersOf(live.sessionId)).toContainEqual(
        { path: at('umbrella/service'), name: 'service', state: 'git', repositoryPath: at('umbrella/service'), source: 'codebase', granted: true },
      )
    } finally {
      live.runtime.shutdown()
    }
  })
})

describe('a prompt that names a path', () => {
  const runInput = (permissionMode: PermissionMode): SessionRunInput => ({
    provider: 'codex', agentSessionId: null, forked: false, workingDirectory: at('shop/api'), projectPath: at('shop/api'),
    gitContext: null, worktreeBaseBranch: null, contextWindow: null, model: 'model-test', preferredModel: 'model-test',
    reasoningEffort: 'medium', fastMode: false, permissionMode, rateLimitBehavior: 'queue', extraInstructions: '',
  })
  type PromptOrigin = Pick<PromptOptions, 'sender' | 'via'>
  /** The prompt trigger, which `PromptDispatch.submitPrompt` runs before the launch of a prompt from a client. */
  const attachNamed = (runtime: Runtime, sessionId: string, mode: PermissionMode, prompt: string, origin: PromptOrigin = {}): Promise<void> => {
    return Reflect.apply(Reflect.get(runtime.dispatch, 'attachNamedFolders'), runtime.dispatch, [sessionId, runInput(mode), { prompt, ...origin }, HOST_ACTOR])
  }

  test('attaches the project of a path before the launch in the modes that ask nothing', async () => {
    for (const mode of ['full-access', 'auto'] as const) {
      const runtime = new runtimeModule.SessionRuntime(new Map(), { temporaryPlaces: [] })
      try {
        const sessionId = `prompt-${mode}`
        // No turn of the session started: the working directory of the prompt says what the session has already.
        await attachNamed(runtime, sessionId, mode, [
          `Make the change in ${at('libs/ui/src')} and read @"${at('designs/specs/login.md')}".`,
          `The log names ${at('tools/cli/src/main.ts')}. Ignore ${at('nowhere/else.ts')} and ${at('shop/api/src/main.ts')}.`,
          `[Attached image: ${at('data/attachments/bucket/shot.png')}]`,
        ].join('\n'))
        // A folder in a repository gives the root of the repository, and a mentioned file in a listed project gives
        // the project, not the folder of the file. A file path in the text, a path that does not exist, a path in the
        // working directory, and an uploaded file give nothing.
        expect(paths(runtime.sessionFolders.foldersOf(sessionId))).toEqual([at('designs'), at('libs/ui')])
      } finally {
        runtime.shutdown()
      }
    }
  })

  test('a folder that is no repository and no listed project attaches nothing', async () => {
    // WHY: a prompt said "the file is in ~/Downloads", and the full folder of downloads of the person became a
    // folder of the session. Only a real project is attached with no request by name.
    for (const mode of ['full-access', 'auto'] as const) {
      const live = await liveSession(`prompt-plain-${mode}`, mode)
      try {
        await attachNamed(live.runtime, live.sessionId, mode, `The export is in ${at('notes')}. Read @"${at('notes/todo.md')}" and look in ${at('drafts')}.`)
        expect(live.runtime.sessionFolders.foldersOf(live.sessionId)).toEqual([])
        // The agent and a person can still ask for the folder by its name.
        expect(await live.request(at('notes'))).toEqual({ kind: 'attached', folder: at('notes'), addedToCodebase: false })
      } finally {
        live.runtime.shutdown()
      }
    }
  })

  test('a prompt that no person wrote attaches nothing', async () => {
    // WHY: the report of a child session named a directory in a sentence, and that directory became a folder of the
    // parent session. Only a prompt that a person wrote in a client is a request of a person.
    const text = `The work is done. The change is in ${at('libs/ui')}, and @"${at('tools/cli/src/main.ts')}" has the test.`
    const notByAPerson: PromptOrigin[] = [
      { sender: { kind: 'agent', sessionId: 'parent-session', name: 'Coordinator' } },
      { via: 'automation', sender: { kind: 'automation', automationId: 'nightly', name: 'Nightly check' } },
      { via: 'session-report' },
      { via: 'background-command' },
      { via: 'pull-request-watch' },
    ]
    const runtime = new runtimeModule.SessionRuntime(new Map(), { temporaryPlaces: [] })
    try {
      for (const origin of notByAPerson) await attachNamed(runtime, 'prompt-sender', 'full-access', text, origin)
      expect(runtime.sessionFolders.foldersOf('prompt-sender')).toEqual([])
      // The same text from a person attaches the two projects.
      await attachNamed(runtime, 'prompt-sender', 'full-access', text)
      expect(paths(runtime.sessionFolders.foldersOf('prompt-sender'))).toEqual([at('libs/ui'), at('tools/cli')])
    } finally {
      runtime.shutdown()
    }
  })

  test('a message that an agent or Solus sends to a session attaches nothing, also with no sender', async () => {
    // WHY: `promptSession` is the entry of each prompt that no client typed: a report, `send_session`, a watch, a webhook.
    // A caller that names no sender (a session on a different host) is still not a person at the composer.
    const live = await liveSession('prompt-session', 'full-access')
    try {
      const { runtime, sessionId } = live
      runtime.activeSessions.get(sessionId)!.runInput = runInput('full-access')
      const turns: string[] = []
      runtime.runTurn = (async (request: { options: PromptOptions }) => { turns.push(request.options.prompt); return { disposition: 'queued' } }) as never
      runtime.seatForTurn = (async () => undefined) as never
      const text = `Please continue in ${at('libs/ui')}.`
      await runtime.dispatch.promptSession(sessionId, text, 'queue')
      await runtime.dispatch.promptSession(sessionId, text, 'queue', { via: 'session-report' })
      expect(turns).toEqual([text, text])
      expect(runtime.sessionFolders.foldersOf(sessionId)).toEqual([])
    } finally {
      live.runtime.shutdown()
    }
  })

  test('the path of an attachment attaches nothing, in each permission mode', async () => {
    // WHY: a person pasted a screenshot into a prompt. The client wrote the path of the file, the prompt trigger attached
    // the folder of the file, and a codebase formed from it. A pasted or dropped file is not a request to work in a folder.
    for (const mode of ['full-access', 'auto', 'supervised', 'accept-edits', 'plan'] as const) {
      // No temporary place is refused here: only the rule of the prompt trigger keeps these folders out.
      const live = await liveSession(`pasted-${mode}`, mode)
      try {
        await attachNamed(live.runtime, live.sessionId, mode, [
          `[Attached image: ${at('scratch/shot.png')}]`,
          `[Attached file: ${at('notes/todo.md')}]`,
          `[Attached file: ${at('drafts')}]`,
          '[Browser annotation: Header]',
          `Annotated capture: ${at('scratch/annotated.png')}`,
          '',
          'What is wrong in this picture?',
        ].join('\n'))
        expect(live.runtime.sessionFolders.foldersOf(live.sessionId)).toEqual([])
        expect(live.cards).toEqual([])
      } finally {
        live.runtime.shutdown()
      }
    }
  })

  test('a path in a temporary directory of the system or in the data of Solus attaches nothing', async () => {
    for (const mode of ['full-access', 'auto'] as const) {
      const runtime = new runtimeModule.SessionRuntime(new Map(), { temporaryPlaces: [at('system-temp')] })
      try {
        const sessionId = `prompt-refused-${mode}`
        // A directory that the person typed, and a file that the person mentioned: each is a trigger for a folder of the work.
        await attachNamed(runtime, sessionId, mode, `Look in ${at('system-temp/clone')} and ${at('data/exports')}, and read @${at('system-temp/screens/shot.png')}.`)
        expect(runtime.sessionFolders.foldersOf(sessionId)).toEqual([])
        await attachNamed(runtime, sessionId, mode, `Look in ${at('data/attachments/bucket')} and read @${at('data/mirror/src/main.ts')}. Then change ${at('libs/ui')}.`)
        expect(paths(runtime.sessionFolders.foldersOf(sessionId))).toEqual([at('libs/ui')])
      } finally {
        runtime.shutdown()
      }
    }
  })

  test('attaches nothing in a mode that asks: there the agent calls attach_folder', async () => {
    for (const mode of ['supervised', 'accept-edits', 'plan'] as const) {
      const live = await liveSession(`prompt-${mode}`, mode)
      try {
        await attachNamed(live.runtime, live.sessionId, mode, `Read ${at('libs/ui/src/main.ts')}`)
        expect(live.runtime.sessionFolders.foldersOf(live.sessionId)).toEqual([])
        expect(live.cards).toEqual([])
      } finally {
        live.runtime.shutdown()
      }
    }
  })
})
