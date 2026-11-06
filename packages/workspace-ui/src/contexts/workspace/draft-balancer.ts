import { checkBalancedHost } from '@solus/client-core/host-balance'
import { serverConnections } from '@solus/client-core/server-connections'
import type { PersonalSettings } from '@solus/contracts/settings'
import type { RunConfig, RunLocation } from '@solus/contracts/types'
import { balanceCandidates, type BalanceCandidate } from '../../components/servers/lib/run-on-balance'
import { serversStore } from '../connections/servers.store.svelte'
import { projectsStore } from '../projects/projects.store.svelte'
import { openFolder, projectHome, runHost } from './run-location'
import type { SessionDraft } from './session-draft.svelte'

/**
 * Auto balance on a draft (docs/plans/resource-telemetry.md D7). `SessionDrafts`
 * loads this module on the first check, so a person with Auto balance off never
 * loads it.
 */

type BalanceSettings = Pick<PersonalSettings, 'hostBalancing' | 'activeAgent'>

/** Whether `next` is the same choice of where to start as `previous`. What Git
 *  answers fills a value that was not known; a value that changed was chosen.
 *  It lives here, not in `run-location.ts`, because only Auto balance asks it. */
export function sameStart(previous: RunLocation, next: RunLocation): boolean {
  const before = previous.checkout
  const after = next.checkout
  if (before.kind !== 'folder' || after.kind !== 'folder') return before === after
  const filled = (known: string | null | undefined, answer: string | null | undefined) => !known || known === answer
  return before.serverId === after.serverId
    && before.path === after.path
    && !before.newWorktree === !after.newWorktree
    && filled(before.git?.worktreePath, after.git?.worktreePath)
    && filled(before.git?.branch, after.git?.branch)
    && filled(before.newWorktree?.baseBranch, after.newWorktree?.baseBranch)
}

/** The hosts Auto balance may choose for this run. Fewer than two is no choice. */
export function draftBalanceCandidates(settings: BalanceSettings, run: RunConfig): BalanceCandidate[] {
  if (!settings.hostBalancing.enabled) return []
  const home = projectHome(run)
  const agentId = run.provider ?? settings.activeAgent
  return balanceCandidates({
    run,
    servers: serversStore.executionServers,
    checkouts: home.path !== '~' ? projectsStore.checkoutsOf(projectsStore.projectKeyFor(home.serverId, home.path)) : [],
    balancing: settings.hostBalancing,
    runsAgent: (serverId) => {
      const agents = serverConnections.connectionFor(serverId)?.facts.value('machine')?.agents
      return !agents || agents.some((agent) => agent.id === agentId && agent.available !== false)
    },
  })
}

export class DraftBalancer {
  /** Each draft's latest check. An older one that settles late does nothing. */
  private readonly checks = new WeakMap<SessionDraft, symbol>()
  /** Where the draft stood when Auto balance last acted. A move away from it
   *  that Git did not make is a choice of the person's. */
  private readonly placed = new WeakMap<SessionDraft, RunLocation>()

  constructor(
    private readonly settings: BalanceSettings,
    private readonly drafts: ReadonlyMap<string, SessionDraft>,
  ) {}

  /**
   * Ask the eligible hosts for their load, and act on the answer. The choice
   * then stays: nothing checks again until the person asks. The draft always
   * names a host, so a failed check leaves it where it is, and Send works.
   * `from` is where the check began, which a first load can leave behind. No
   * `from` is the Run on row: a person who asks has more say than a check.
   */
  async check(draft: SessionDraft, from?: RunLocation): Promise<void> {
    const requested = !from
    this.placed.set(draft, from ?? draft.run.location)
    const candidates = draftBalanceCandidates(this.settings, draft.run)
    if (candidates.length < 2) {
      draft.balance = null
      return
    }
    const check = Symbol('balance')
    this.checks.set(draft, check)
    draft.balance = 'checking'
    const hostId = await checkBalancedHost(candidates.map(({ serverId, preference }) => ({
      hostId: serverId,
      preference,
      read: () => serverConnections.apiFor(serverId).hostResources(),
    })))
    if (this.checks.get(draft) !== check || this.drafts.get(draft.id) !== draft) return
    this.checks.delete(draft)
    draft.balance = this.apply(draft, candidates.find((candidate) => candidate.serverId === hostId), requested)
  }

  /**
   * The state the draft ends in. Writing keeps a draft where it is: a check
   * must not move the words under a person, so it leaves the draft with no
   * balance state, because the check did not choose that host. Only asking
   * moves a written draft, and attachments stay on their host even then.
   */
  private apply(draft: SessionDraft, chosen: BalanceCandidate | undefined, requested: boolean): SessionDraft['balance'] {
    if (!chosen) return 'unavailable'
    const moves = chosen.serverId !== runHost(draft.run)
    if (moves && !requested && !draft.isEmpty) return null
    if (moves && draft.prompt.attachments.length > 0) return 'unavailable'
    if (moves || requested) {
      // Cleared first: this move is the check's, not a choice of the person's.
      draft.balance = null
      draft.moveTo(openFolder(draft.run.location, { serverId: chosen.serverId, path: chosen.path }))
      this.placed.set(draft, draft.run.location)
    }
    return 'chosen'
  }

  /** A host, branch, or worktree the person chose ends Auto balance on this
   *  draft, from every entry point. Another project is a new question. */
  async afterMove(draft: SessionDraft): Promise<void> {
    const previous = this.placed.get(draft)
    if (!previous) return
    if (sameStart(previous, draft.run.location)) {
      // Git filled it in: a later change of the same value is a choice.
      this.placed.set(draft, draft.run.location)
      return
    }
    this.checks.delete(draft)
    const before = previous.project
    const after = projectHome(draft.run)
    if (projectsStore.projectKeyFor(before.serverId, before.path) !== projectsStore.projectKeyFor(after.serverId, after.path)) await this.check(draft, draft.run.location)
    else draft.balance = null
  }
}
