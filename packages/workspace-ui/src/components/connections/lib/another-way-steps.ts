import type { OutsideAppGuide } from '@solus/contracts/outside-apps'

/** What a step of "Set up another way" carries under its title. */
export type AnotherWayAttachment = 'address' | 'message' | 'code' | null

/** One step of the "Set up another way" timeline, as `StepRail` draws it. */
export interface AnotherWayStep {
  title: string
  hint?: string
  state: 'done' | 'current' | 'next'
  attachment: AnotherWayAttachment
}

/** Where the person is: what they copied last, and whether the app signed in. */
export interface AnotherWayProgress {
  copied: 'address' | 'message' | null
  hasSignedIn: boolean
}

/** The step of the app's own instructions that the address or the message goes with: the one that says to send it or paste it, else the last. */
function attachmentIndex(steps: readonly string[], attachment: 'address' | 'message'): number {
  const words = attachment === 'message' ? /\b(send|message)\b/i : /\b(paste|address)\b/i
  const found = steps.findIndex((step) => words.test(step))
  return found === -1 ? steps.length - 1 : found
}

/**
 * "Set up another way" as a timeline (docs/outside-apps.md): the app's own
 * steps, with the address or the message on the step that uses it, then the
 * code, then the sign-in. Copying the address or the message marks its step
 * and the steps before it done; the sign-in marks every step done. A step
 * cannot be seen inside the other app, so only these two facts move it.
 */
export function anotherWaySteps(guide: OutsideAppGuide | null, hasMessage: boolean, progress: AnotherWayProgress): AnotherWayStep[] {
  const appName = guide?.name ?? 'the app'
  const own = guide?.steps.length ? guide.steps : ['Add a remote MCP server with OAuth, and paste the address.']
  const handOff: 'address' | 'message' = hasMessage ? 'message' : 'address'
  const handOffIndex = attachmentIndex(own, handOff)
  const steps: Omit<AnotherWayStep, 'state'>[] = [
    ...own.map((title, index) => {
      const step: Omit<AnotherWayStep, 'state'> = { title, attachment: index === handOffIndex ? handOff : null }
      // The app's note is about the address or the message, so it goes on that step.
      if (index === handOffIndex && guide?.note) step.hint = guide.note
      return step
    }),
    { title: `When ${appName} asks for a code, enter this one`, attachment: 'code' as const },
    { title: `${capitalized(appName)} signs in`, hint: progress.hasSignedIn ? undefined : `Solus waits for ${appName} here.`, attachment: null },
  ]
  const doneThrough = progress.hasSignedIn ? steps.length - 1 : progress.copied === handOff ? handOffIndex : -1
  return steps.map((step, index) => ({
    ...step,
    state: index <= doneThrough ? 'done' : index === doneThrough + 1 ? 'current' : 'next',
  }))
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
