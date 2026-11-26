import { describe, expect, test } from 'bun:test'
import type { AgentHistoryProject } from '@solus/contracts/agent-history'
import {
  ageLabel,
  defaultCheckedProjects,
  footerFor,
  isAlreadyDone,
  nextOpenStep,
  progressLine,
  reachRows,
  RECENT_PROJECT_MS,
  skipEffect,
  stepsFor,
  timeline,
  type AlreadyDoneFacts,
  type FooterFacts,
  type OnboardingStep,
} from '@solus/workspace-ui/components/onboarding/lib/onboarding-model'
import { stepCopy, type StepCopyFacts } from '@solus/workspace-ui/components/onboarding/lib/step-copy'
import { agentRow, signInTerminalText } from '@solus/workspace-ui/components/onboarding/lib/agent-rows'
import { phonePairLink } from '@solus/workspace-ui/components/onboarding/lib/phone-pairing'
import { radioArrowKey } from '@solus/workspace-ui/components/onboarding/lib/radio-keys'
import type { ProviderRow } from '@solus/workspace-ui/components/servers/lib/host-onboarding'

// The one-page onboarding (docs/plans/one-page-onboarding.md).

const NONE = new Set<OnboardingStep>()

const FACTS: FooterFacts = {
  choice: 'account',
  signingIn: false,
  signedIn: false,
  readyAgents: 0,
  pendingAgent: null,
  checkedProjects: 0,
  landingProject: null,
  machineTarget: 'cloud',
  machineOffered: true,
  hasCloudHost: false,
  hasLinkCommand: false,
  githubConnected: false,
  repositoryName: null,
  isBusy: false,
}

describe('the steps of each flow', () => {
  test('the desktop asks where the setup lives first, and the last step follows that answer (decisions 3 and 4)', () => {
    // WHY: where the setup lives decides where logins and settings are kept,
    // so it comes before anything is set up. An account offers reach from
    // anywhere; a machine that keeps everything to itself offers its phone.
    expect(stepsFor('desktop', 'account')).toEqual(['setup', 'agents', 'projects', 'reach'])
    expect(stepsFor('desktop', 'local')).toEqual(['setup', 'agents', 'projects', 'phone'])
  })

  test('a browser paired to a host has no account to choose, so it gets the local steps without step 1', () => {
    expect(stepsFor('host', 'account')).toEqual(['agents', 'projects', 'phone'])
  })

  test('the web flow is where agents run, the agents, and the code (decision 5)', () => {
    expect(stepsFor('cloud', 'account')).toEqual(['machine', 'agents', 'code'])
    expect(stepsFor('cloud', 'local')).toEqual(['machine', 'agents', 'code'])
  })

  test('Skip on step 1 keeps everything on this machine; elsewhere it only moves on (decision 3)', () => {
    expect(skipEffect('setup')).toBe('choose-local')
    for (const step of ['agents', 'projects', 'phone', 'reach', 'machine', 'code'] as const) expect(skipEffect(step)).toBe('next')
  })

  test('the next open step is the first one not done, so an edited step returns to where the person was', () => {
    const steps = stepsFor('desktop', 'local')
    expect(nextOpenStep(steps, new Set(['setup']))).toBe('agents')
    expect(nextOpenStep(steps, new Set(['setup', 'agents', 'projects']))).toBe('phone')
    expect(nextOpenStep(steps, new Set(steps))).toBeNull()
  })
})

describe('the timeline', () => {
  test('one step is open, done steps fold with a check, and the rest are next', () => {
    const entries = timeline({ steps: stepsFor('desktop', 'local'), open: 'projects', done: new Set(['setup', 'agents']), working: NONE, signingIn: false })
    expect(entries.map((entry) => [entry.step, entry.status, entry.marker])).toEqual([
      ['setup', 'done', 'check'],
      ['agents', 'done', 'check'],
      ['projects', 'open', 'number'],
      ['phone', 'next', 'number'],
    ])
    expect(entries.filter((entry) => entry.status === 'open')).toHaveLength(1)
  })

  test('while the browser sign-in runs, step 1 spins and every other step waits on it (decision 3)', () => {
    // WHY: the account decides where logins go; an agent signed in before the
    // sign-in ends would be kept in the wrong place.
    const entries = timeline({ steps: stepsFor('desktop', 'account'), open: 'setup', done: NONE, working: NONE, signingIn: true })
    expect(entries[0]).toMatchObject({ step: 'setup', status: 'open', marker: 'spinner' })
    expect(entries.slice(1).map((entry) => entry.status)).toEqual(['waiting', 'waiting', 'waiting'])
    expect(stepCopy('agents', 'waiting', COPY).detail).toBe('Opens after you sign in')
  })

  test('a done step whose work goes on in the background keeps a spinner marker', () => {
    const entries = timeline({ steps: stepsFor('cloud', 'account'), open: 'agents', done: new Set(['machine']), working: new Set(['machine']), signingIn: false })
    expect(entries[0]).toMatchObject({ step: 'machine', status: 'done', marker: 'spinner' })
  })

  test('the header counts steps, and names an optional last step as optional', () => {
    const steps = stepsFor('desktop', 'local')
    expect(progressLine(steps, 'agents')).toBe('Step 2 of 4.')
    expect(progressLine(steps, 'phone')).toBe('Last step, and it’s optional.')
    expect(progressLine(stepsFor('cloud', 'account'), 'code')).toBe('Step 3 of 3.')
    expect(progressLine(stepsFor('cloud', 'account'), null)).toBe('is ready.')
  })
})

describe('the footer', () => {
  test('step 1 signs in with the account preselected, and waits on the browser while it runs', () => {
    expect(footerFor('setup', FACTS).primaryLabel).toBe('Sign in to Solus Cloud')
    expect(footerFor('setup', { ...FACTS, choice: 'local' }).primaryLabel).toBe('Continue')
    const waiting = footerFor('setup', { ...FACTS, signingIn: true })
    expect(waiting).toMatchObject({ primaryLabel: 'Continue', primaryEnabled: false, hint: 'Waiting for your browser…' })
  })

  test('one ready agent is enough to continue; none still lets the person skip', () => {
    expect(footerFor('agents', FACTS)).toMatchObject({ primaryEnabled: false, secondary: 'skip' })
    expect(footerFor('agents', { ...FACTS, readyAgents: 1 }).primaryEnabled).toBe(true)
    expect(footerFor('agents', { ...FACTS, pendingAgent: 'Codex' }).hint).toBe('Codex can finish later.')
  })

  test('the last desktop step starts in the first chosen project', () => {
    expect(footerFor('projects', { ...FACTS, checkedProjects: 3 }).primaryLabel).toBe('Continue with 3 projects')
    expect(footerFor('phone', { ...FACTS, landingProject: 'solus' }).primaryLabel).toBe('Start in solus')
    expect(footerFor('reach', FACTS).primaryLabel).toBe('Start')
  })

  test('the cloud ready state starts in the repository and offers to invite the team instead of Skip', () => {
    expect(footerFor(null, { ...FACTS, repositoryName: 'landing-page' })).toMatchObject({ primaryLabel: 'Start in landing-page', secondary: 'invite' })
  })

  test('the code step needs GitHub, then a repository, before it can clone', () => {
    expect(footerFor('code', FACTS).primaryLabel).toBe('Connect GitHub')
    expect(footerFor('code', { ...FACTS, githubConnected: true }).primaryEnabled).toBe(false)
    expect(footerFor('code', { ...FACTS, githubConnected: true, repositoryName: 'api' })).toMatchObject({ primaryLabel: 'Clone and start', primaryEnabled: true })
  })

  test('a running action disables the primary, so Enter cannot start it twice', () => {
    expect(footerFor('projects', { ...FACTS, isBusy: true }).primaryEnabled).toBe(false)
  })
})

describe('reach it from anywhere (decision 4)', () => {
  test('Link this Mac is off by default: an unknown link state reads as off', () => {
    expect(reachRows({ linked: undefined, busy: false, signedIn: true }).link.checked).toBe(false)
    expect(reachRows({ linked: false, busy: false, signedIn: true }).link.checked).toBe(false)
    expect(reachRows({ linked: true, busy: false, signedIn: true }).link.checked).toBe(true)
  })

  test('sharing with the organization is disabled until the link is on', () => {
    const off = reachRows({ linked: false, busy: false, signedIn: true })
    expect(off.share).toEqual({ disabled: true, detail: 'Link this Mac first.' })
    expect(reachRows({ linked: true, busy: false, signedIn: true }).share.disabled).toBe(false)
  })

  test('nothing can be linked without the account, or while a link change runs', () => {
    expect(reachRows({ linked: false, busy: false, signedIn: false }).link.disabled).toBe(true)
    expect(reachRows({ linked: true, busy: true, signedIn: true }).share.disabled).toBe(true)
  })
})

describe('projects from agent history (decision 6)', () => {
  const now = Date.UTC(2026, 10, 26)
  const project = (name: string, daysAgo: number, extra: Partial<AgentHistoryProject> = {}): AgentHistoryProject => ({
    path: `/Users/a/${name}`,
    name,
    sources: ['claude-code'],
    threadCount: 1,
    lastUsedAt: now - daysAgo * 86_400_000,
    exists: true,
    isProject: false,
    ...extra,
  })

  test('the recent folders are checked; old, missing, and already added folders are not', () => {
    const checked = defaultCheckedProjects([
      project('old', RECENT_PROJECT_MS / 86_400_000 + 1),
      project('solus', 0),
      project('gone', 1, { exists: false }),
      project('added', 1, { isProject: true }),
      project('t3code', 3),
    ], now)
    expect(checked).toEqual(['/Users/a/solus', '/Users/a/t3code'])
  })

  test('at most five are checked, newest first', () => {
    const many = Array.from({ length: 8 }, (_, index) => project(`p${index}`, index))
    expect(defaultCheckedProjects(many, now)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4'].map((name) => `/Users/a/${name}`))
  })

  test('the age fits the row’s trailing lane', () => {
    expect([0, 3, 14, 90].map((days) => ageLabel(now - days * 86_400_000, now))).toEqual(['today', '3d', '2w', '3mo'])
  })
})

const COPY: StepCopyFacts = {
  flow: 'desktop',
  choice: 'local',
  email: null,
  machineNoun: 'Mac',
  readyAgentNames: ['Claude Code'],
  laterAgentNames: ['Codex'],
  projectNames: ['solus', 'solus-cloud', 't3code'],
  machine: { target: 'cloud', isWorking: true, summary: 'Starting in the background · about a minute' },
  repository: null,
  folded: new Set(),
}

describe('a step with nothing left to do folds as done (decision 10)', () => {
  const now = Date.UTC(2026, 10, 26)
  const NOTHING: AlreadyDoneFacts = {
    flow: 'desktop', isSignedIn: false, hasEveryHostAgent: false, history: null, now,
    isLinked: false, hasMachine: false, hasAccountAgent: false, hasCloudProject: false,
  }
  const folder = (isProject: boolean, daysAgo = 0): AgentHistoryProject => ({
    path: `/Users/a/${isProject ? 'added' : 'new'}-${daysAgo}`, name: 'x', sources: ['codex'], threadCount: 1,
    lastUsedAt: now - daysAgo * 86_400_000, exists: true, isProject,
  })

  test('nothing folds on facts that are false or not known yet', () => {
    const steps: OnboardingStep[] = ['setup', 'agents', 'projects', 'reach', 'phone', 'machine', 'code']
    expect(steps.filter((step) => isAlreadyDone(step, NOTHING))).toEqual([])
  })

  test('on a second device the account and this Mac answer the desktop steps', () => {
    const facts = { ...NOTHING, isSignedIn: true, hasEveryHostAgent: true, isLinked: true, history: [folder(true)] }
    expect((['setup', 'agents', 'projects', 'reach'] as const).every((step) => isAlreadyDone(step, facts))).toBe(true)
  })

  test('one agent signed in is not enough to fold the desktop Agents step', () => {
    // WHY: the step is where the second agent signs in on this Mac; the account cannot do it.
    expect(isAlreadyDone('agents', { ...NOTHING, hasAccountAgent: true })).toBe(false)
  })

  test('Projects folds only when every recent folder is a project already, never for a first-time person', () => {
    expect(isAlreadyDone('projects', { ...NOTHING, history: [] })).toBe(false)
    expect(isAlreadyDone('projects', { ...NOTHING, history: [folder(true), folder(false, 1)] })).toBe(false)
    expect(isAlreadyDone('projects', { ...NOTHING, history: [folder(true), folder(false, 60)] })).toBe(true)
  })

  test('the cloud steps fold on what the account already has', () => {
    const cloud = { ...NOTHING, flow: 'cloud' as const, hasMachine: true, hasAccountAgent: true, hasCloudProject: true }
    expect((['machine', 'agents', 'code'] as const).every((step) => isAlreadyDone(step, cloud))).toBe(true)
    expect(isAlreadyDone('setup', { ...cloud, isSignedIn: true })).toBe(false)
  })

  test('the phone step never folds', () => {
    expect(isAlreadyDone('phone', { ...NOTHING, isSignedIn: true, isLinked: true })).toBe(false)
  })
})

describe('the words of a folded step', () => {
  test('a done step says what was decided, in one line', () => {
    expect(stepCopy('setup', 'done', COPY)).toMatchObject({ title: 'This Mac only', editLabel: 'Change' })
    expect(stepCopy('agents', 'done', COPY).detail).toBe('Claude Code ready · Codex later')
    expect(stepCopy('projects', 'done', COPY).detail).toBe('solus, solus-cloud, t3code')
  })

  test('a step that opened folded says what was already true, not what was skipped', () => {
    const folded = { ...COPY, projectNames: [], folded: new Set<OnboardingStep>(['projects', 'reach', 'code']) }
    expect(stepCopy('projects', 'done', folded).detail).toBe('Your recent folders are projects already')
    expect(stepCopy('reach', 'done', folded).detail).toBe('This Mac is linked to your account')
    expect(stepCopy('code', 'done', { ...folded, flow: 'cloud' }).detail).toBe('Your projects are in Solus Cloud already')
  })

  test('a cloud host that still starts offers Change, not Edit', () => {
    expect(stepCopy('machine', 'done', { ...COPY, flow: 'cloud' }).editLabel).toBe('Change')
  })
})

describe('an agent row in the Agents step (§3.1)', () => {
  const row = (state: ProviderRow['state']): ProviderRow => ({ id: 'codex', label: 'Codex', detail: 'Installed · not signed in', state, actionLabel: 'Sign in' })

  test('a host that is not signed in offers its own sign-in', () => {
    expect(agentRow({ row: row('available'), verification: undefined, machineNoun: 'Mac' }).trailing)
      .toEqual({ kind: 'action', text: 'Sign in' })
  })

  test('a signed-in host is ready, and its login stays on the host in either setup', () => {
    // WHY (decision 7): cloud hosts sign in on their own, so the row never speaks of the account.
    expect(agentRow({ row: row('done'), verification: undefined, machineNoun: 'Mac' }))
      .toEqual({ detail: 'Signed in on this Mac', trailing: { kind: 'ready', text: 'Ready' } })
  })

  test('a relayed login waits on the browser and shows the CLI’s output', () => {
    const verification = { verificationUrl: 'https://auth.openai.com/device', userCode: 'ABCD-1234', requiresCodeInput: false }
    expect(agentRow({ row: row('busy'), verification, machineNoun: 'Mac' }).trailing.text).toBe('Finish in your browser')
    expect(signInTerminalText('codex', verification).split('\n')).toEqual([
      '~ $ codex login --device-auth',
      'Opened your browser to sign in…',
      'https://auth.openai.com/device',
      'Enter this code: ABCD-1234',
    ])
  })
})

describe('small interaction rules', () => {
  test('the phone pairs over the local network, never through a loopback address', () => {
    const loopback = { kind: 'loopback' as const, host: '127.0.0.1', port: 4100 }
    const lan = { kind: 'lan' as const, host: '192.168.1.4', port: 4100 }
    expect(phonePairLink([loopback], 'token')).toBeNull()
    expect(phonePairLink([loopback, lan], 'token')).toContain('192.168.1.4')
    expect(phonePairLink([lan], null)).toBeNull()
  })

  test('arrow keys move through a radio group and wrap', () => {
    expect(radioArrowKey('ArrowDown', ['account', 'local'], 'account')).toBe('local')
    expect(radioArrowKey('ArrowDown', ['account', 'local'], 'local')).toBe('account')
    expect(radioArrowKey('ArrowUp', ['account', 'local'], 'account')).toBe('local')
    expect(radioArrowKey('Enter', ['account', 'local'], 'account')).toBeNull()
  })
})
