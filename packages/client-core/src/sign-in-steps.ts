import type { SeatProvider } from '@solus/contracts/seats'

/**
 * The two steps of a Claude or Codex sign-in, in words a person who is not a
 * developer can follow. Claude's page shows a code to paste back; Codex shows a
 * code here to enter on its page. Pure, so every surface says the same thing.
 */

export type SignInCodeFlow = 'paste' | 'enter'
export type SignInPhase = 'start' | 'code' | 'checking'

export interface SignInStep {
  title: string
  hint?: string
  state: 'done' | 'current' | 'next'
}

/** Before the host answers, the provider says which way the code goes. */
export function signInCodeFlow(provider: SeatProvider): SignInCodeFlow {
  return provider === 'claude-code' ? 'paste' : 'enter'
}

export function signInLead(label: string, flow: SignInCodeFlow): string {
  return flow === 'paste'
    ? `This takes about a minute. You'll sign in on ${label}'s website, then paste a short code here.`
    : `This takes about a minute. You'll sign in on ${label}'s website and enter a short code there.`
}

export function signInSteps(label: string, flow: SignInCodeFlow, phase: SignInPhase): [SignInStep, SignInStep] {
  if (phase === 'start') {
    return [
      { title: `Open ${label} and sign in`, hint: "We'll open it in your browser.", state: 'current' },
      flow === 'paste'
        ? { title: `Paste the code ${label} shows you`, hint: "It's a short line of letters and numbers.", state: 'next' }
        : { title: `Enter a short code on ${label}'s page`, hint: "We'll show you the code here.", state: 'next' },
    ]
  }
  const opened: SignInStep = { title: `Open ${label} and sign in`, state: 'done' }
  if (flow === 'enter') {
    return [opened, { title: `Enter this code on ${label}'s page`, hint: `Solus finishes on its own once ${label} confirms it.`, state: 'current' }]
  }
  return phase === 'checking'
    ? [opened, { title: 'Checking your code…', hint: 'This usually takes a few seconds.', state: 'current' }]
    : [opened, { title: `Paste the code ${label} shows you`, hint: 'Copy it from the page, then paste it below.', state: 'current' }]
}
