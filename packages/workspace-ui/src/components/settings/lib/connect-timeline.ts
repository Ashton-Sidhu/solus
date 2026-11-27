import type { IntegrationAuth } from '@solus/contracts/integration-types'
import type { ConnectStep } from './integration-labels'

/** One step of the connect dialog's timeline, as `StepRail` draws it. */
export interface ConnectTimelineStep {
  key: 'server' | 'sign-in' | 'tools'
  title: string
  hint: string
  state: 'done' | 'current' | 'next'
}

export interface ConnectTimelineInput {
  step: ConnectStep
  /** The server is a command the host starts: its second step is Start and test, not a sign-in. */
  isCommand: boolean
  /** Start and test runs now. */
  isStarting: boolean
  /** The server's name and where it is, once step 1 is done. */
  server: { name: string; where: string }
  /** What the sign-in step says once it is done, such as "Connected as Ada". */
  signedInText: string
}

/**
 * The connect dialog as one timeline (docs/integrations.md): the server, then
 * its sign-in (or, for a command, Start and test), then the tools. A done step
 * folds to one line that says what was chosen, so the person sees what they
 * are signing in to.
 */
export function connectTimeline(input: ConnectTimelineInput): ConnectTimelineStep[] {
  const { step, isCommand, isStarting } = input
  const isServerOpen = (step === 'source' || step === 'address' || step === 'command') && !isStarting
  const isToolsOpen = step === 'tools'
  return [
    isServerOpen
      ? { key: 'server', title: 'Server', hint: 'A URL, a command, or the JSON from a server’s setup page.', state: 'current' }
      : { key: 'server', title: input.server.name, hint: input.server.where, state: 'done' },
    isCommand
      ? { key: 'sign-in', title: 'Start and test', hint: isToolsOpen ? 'It started and listed its tools.' : 'Solus runs it once and lists its tools.', state: isToolsOpen ? 'done' : isStarting ? 'current' : 'next' }
      : {
          key: 'sign-in',
          title: 'Sign in',
          hint: isToolsOpen ? input.signedInText : 'Solus checks what the server needs, and asks only for that.',
          state: isToolsOpen ? 'done' : isServerOpen ? 'next' : 'current',
        },
    { key: 'tools', title: 'Choose tools', hint: 'Pick what agents may use.', state: isToolsOpen ? 'current' : 'next' },
  ]
}

/** How a server signs in, in a few words, for its done step: "signs in with OAuth". Empty before the host checked it. */
export function signInWords(auth: IntegrationAuth | undefined): string {
  switch (auth?.kind) {
    case 'oauth': return 'signs in with OAuth'
    case 'bearer': return auth.scheme === 'basic' ? 'takes a user name and password' : 'takes an API key'
    case 'headers': return 'takes header values'
    case 'env': return 'takes values'
    case 'none': return 'no sign-in'
    default: return ''
  }
}
