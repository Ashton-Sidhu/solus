import type { SeatConnectStartResult, SeatProvider } from '@solus/contracts/seats'

/**
 * The two steps of an agent sign-in, in words a person who is not a developer
 * can follow. Claude's and Antigravity's pages show a code to paste back; Codex
 * shows a code here to enter on its page. Pure, so every surface says the same thing.
 */

/** `paste-address`: the browser ends on a page that may not load (Gemini Enterprise); its address comes back. */
export type SignInCodeFlow = 'paste' | 'enter' | 'paste-address'
export type SignInPhase = 'start' | 'code' | 'checking'

export interface SignInStep {
  title: string
  hint?: string
  state: 'done' | 'current' | 'next'
}

const CODE_FLOWS = {
  'claude-code': 'paste',
  codex: 'enter',
  // The Antigravity page shows a code after the Google sign-in.
  antigravity: 'paste',
} as const satisfies Record<SeatProvider, SignInCodeFlow>

/** Before the host answers, the provider says which way the code goes. */
export function signInCodeFlow(provider: SeatProvider): SignInCodeFlow {
  return CODE_FLOWS[provider]
}

/** Once the host answers, its sign-in says what comes back. */
export function signInCodeFlowOf(verification: SeatConnectStartResult): SignInCodeFlow {
  if (!verification.requiresCodeInput) return 'enter'
  return verification.input === 'redirect-url' ? 'paste-address' : 'paste'
}

export function signInLead(label: string, flow: SignInCodeFlow): string {
  switch (flow) {
    case 'paste': return `This takes about a minute. You'll sign in on ${label}'s website, then paste a short code here.`
    case 'paste-address': return `This takes about a minute. You'll sign in with Google, then paste the address of the page you end on here.`
    case 'enter': return `This takes about a minute. You'll sign in on ${label}'s website and enter a short code there.`
  }
}

const PASTE_ADDRESS_STEP = { title: 'Paste the address of the page you end on', hint: "The page can say it can't be reached. Copy its whole address from the address bar." }

export function signInSteps(label: string, flow: SignInCodeFlow, phase: SignInPhase): [SignInStep, SignInStep] {
  if (phase === 'start') {
    return [
      { title: `Open ${label} and sign in`, hint: "We'll open it in your browser.", state: 'current' },
      flow === 'paste'
        ? { title: `Paste the code ${label} shows you`, hint: "It's a short line of letters and numbers.", state: 'next' }
        : flow === 'paste-address'
          ? { ...PASTE_ADDRESS_STEP, state: 'next' }
          : { title: `Enter a short code on ${label}'s page`, hint: "We'll show you the code here.", state: 'next' },
    ]
  }
  const opened: SignInStep = { title: `Open ${label} and sign in`, state: 'done' }
  if (flow === 'enter') {
    return [opened, { title: `Enter this code on ${label}'s page`, hint: `Solus finishes on its own once ${label} confirms it.`, state: 'current' }]
  }
  if (phase === 'checking') return [opened, { title: flow === 'paste-address' ? 'Finishing your sign-in…' : 'Checking your code…', hint: 'This usually takes a few seconds.', state: 'current' }]
  return flow === 'paste-address'
    ? [opened, { ...PASTE_ADDRESS_STEP, state: 'current' }]
    : [opened, { title: `Paste the code ${label} shows you`, hint: 'Copy it from the page, then paste it below.', state: 'current' }]
}
