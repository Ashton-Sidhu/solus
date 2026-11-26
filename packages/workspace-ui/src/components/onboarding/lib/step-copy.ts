import type { OnboardingFlow, OnboardingStep, SetupChoice, StepStatus } from './onboarding-model'

/** What the timeline says about the world, for the words of each step. */
export interface StepCopyFacts {
  flow: OnboardingFlow
  choice: SetupChoice
  /** The signed-in account's email, when there is one. */
  email: string | null
  /** "Mac" on macOS, else "computer": the word for this machine in the copy. */
  machineNoun: string
  /** Agents ready to take a turn, by name, and the ones still to set up. */
  readyAgentNames: string[]
  laterAgentNames: string[]
  projectNames: string[]
  machine: { target: 'cloud' | 'own'; isWorking: boolean; summary: string }
  repository: string | null
  /** Steps that opened folded, because nothing was left to do in them. */
  folded: ReadonlySet<OnboardingStep>
}

export interface StepCopy {
  title: string
  detail: string
  /** The word on a folded step's action. */
  editLabel: 'Edit' | 'Change'
}

function agentsDetail(facts: StepCopyFacts): string {
  const ready = facts.readyAgentNames
  if (ready.length === 0) return 'Not set up yet'
  if (facts.flow === 'cloud') return `${ready.join(' and ')} connected`
  const later = facts.laterAgentNames.length > 0 ? ` · ${facts.laterAgentNames.join(' and ')} later` : ''
  return `${ready.join(' and ')} ready${later}`
}

function namesLine(names: readonly string[], empty: string): string {
  if (names.length === 0) return empty
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
}

type CopyOf = (status: StepStatus, facts: StepCopyFacts) => StepCopy

const setupCopy: CopyOf = (status, facts) => {
  const noun = facts.machineNoun
  if (status !== 'done') return { title: 'Where your setup lives', detail: 'Your settings and connections are kept here', editLabel: 'Change' }
  return facts.choice === 'account'
    ? { title: 'Solus Cloud account', detail: `${facts.email ?? 'Signed in'} · your setup syncs from here`, editLabel: 'Change' }
    : { title: `This ${noun} only`, detail: `Nothing leaves this ${noun} · sign in any time`, editLabel: 'Change' }
}

function openAgentsDetail(facts: StepCopyFacts): string {
  if (facts.flow === 'cloud') return 'Sign in once. Every cloud host uses it.'
  return 'One is enough to start'
}

const agentsCopy: CopyOf = (status, facts) => {
  if (status === 'done') return { title: 'Agents', detail: agentsDetail(facts), editLabel: 'Edit' }
  if (status === 'waiting') return { title: 'Your agents', detail: 'Opens after you sign in', editLabel: 'Edit' }
  if (status === 'open') return { title: 'Your agents', detail: openAgentsDetail(facts), editLabel: 'Edit' }
  const detail = facts.flow === 'cloud' ? 'Sign in to Claude Code or Codex once' : 'Claude Code and Codex'
  return { title: 'Your agents', detail, editLabel: 'Edit' }
}

const projectsCopy: CopyOf = (status, facts) => {
  if (status === 'done' && facts.folded.has('projects')) return { title: 'Projects', detail: 'Your recent folders are projects already', editLabel: 'Edit' }
  if (status === 'done') return { title: 'Projects', detail: namesLine(facts.projectNames, 'None added'), editLabel: 'Edit' }
  const detail = status === 'open' ? 'Found in your Claude Code and Codex history' : 'From your Claude Code and Codex history'
  return { title: 'Pick your projects', detail, editLabel: 'Edit' }
}

const phoneCopy: CopyOf = (status) => {
  if (status === 'done') return { title: 'Your phone', detail: 'Pair it any time in Settings', editLabel: 'Edit' }
  const detail = status === 'open' ? 'Optional. Pairs over your Wi-Fi, nothing goes through the cloud.' : 'Optional · pairs over your Wi-Fi'
  return { title: 'Your phone', detail, editLabel: 'Edit' }
}

const reachCopy: CopyOf = (status, facts) => {
  const noun = facts.machineNoun
  if (status === 'done' && facts.folded.has('reach')) return { title: 'Reach it from anywhere', detail: `This ${noun} is linked to your account`, editLabel: 'Edit' }
  if (status === 'done') return { title: 'Reach it from anywhere', detail: 'Link any time in Settings', editLabel: 'Edit' }
  const detail = status === 'open' ? `Optional. Off by default, so this ${noun} stays private until you link it.` : `Link this ${noun} to your account`
  return { title: 'Reach it from anywhere', detail, editLabel: 'Edit' }
}

const machineCopy: CopyOf = (status, facts) => {
  if (status !== 'done') return { title: 'Where your agents run', detail: 'You can add more machines later', editLabel: 'Edit' }
  return {
    title: facts.machine.target === 'own' ? 'Your own computer' : 'Cloud host',
    detail: facts.machine.summary,
    editLabel: facts.machine.isWorking ? 'Change' : 'Edit',
  }
}

const codeCopy: CopyOf = (status, facts) => {
  if (status === 'done' && facts.folded.has('code') && !facts.repository) return { title: 'Your code', detail: 'Your projects are in Solus Cloud already', editLabel: 'Edit' }
  if (status === 'done') {
    return { title: 'Your code', detail: facts.repository ? `${facts.repository} cloned to the host` : 'An empty project', editLabel: 'Edit' }
  }
  const detail = status === 'open' ? 'Pick a repository to clone onto the host' : 'Connect GitHub and pick a repository'
  return { title: 'Your code', detail, editLabel: 'Edit' }
}

const COPY = {
  setup: setupCopy,
  agents: agentsCopy,
  projects: projectsCopy,
  phone: phoneCopy,
  reach: reachCopy,
  machine: machineCopy,
  code: codeCopy,
} satisfies Record<OnboardingStep, CopyOf>

/** The title and the line under it, for a step in the given status. */
export function stepCopy(step: OnboardingStep, status: StepStatus, facts: StepCopyFacts): StepCopy {
  return COPY[step](status, facts)
}

/** The open step 1 while the browser sign-in runs (decision 3). */
export const SIGNING_IN_COPY = {
  title: 'Signing in to Solus Cloud',
  detail: 'Finish in your browser, then come back here. New to Solus? You can create an account there.',
} as const
