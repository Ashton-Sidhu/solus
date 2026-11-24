import type { SignInStep } from '@solus/client-core/sign-in-steps'

/**
 * The two steps of a browser sign-in prompt. The host opened the page before
 * the prompt shows, so the first step is done; the second is what the page
 * asks for: a code to enter there, a code to paste back here, or an approval.
 */
export type DevicePromptAsk = 'enter-code' | 'paste-code' | 'approve'

export function devicePromptSteps(ask: DevicePromptAsk, codeSent: boolean): [SignInStep, SignInStep] {
  const opened: SignInStep = { title: 'Open the sign-in page', hint: 'It opens in your browser.', state: 'done' }
  if (ask === 'enter-code') return [opened, { title: 'Enter this code on the page', state: 'current' }]
  if (ask === 'approve') return [opened, { title: 'Approve the request on the page', state: 'current' }]
  return [opened, codeSent ? { title: 'Checking your code…', state: 'current' } : { title: 'Paste the code the page shows you', state: 'current' }]
}
