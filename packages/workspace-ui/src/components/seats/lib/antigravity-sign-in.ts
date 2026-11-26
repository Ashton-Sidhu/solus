import {
  antigravityBrowserSignInSchema,
  antigravityCredentialSchema,
  type AntigravityBrowserSignIn,
  type AntigravityCredential,
} from '@solus/contracts/seats'

/**
 * The four ways an Antigravity seat signs in (docs/plans/antigravity-provider.md
 * §7), as the seat's sign-in form offers them. Pure, so the form stays markup.
 */
export type AntigravityMethod = AntigravityBrowserSignIn['method'] | AntigravityCredential['method']

export interface AntigravityMethodChoice {
  id: AntigravityMethod
  label: string
  detail: string
  /** Signs in in the browser; else a pasted credential. */
  usesBrowser: boolean
  /** Bills to a Google Cloud project in a location. */
  needsCloudProject: boolean
}

export const ANTIGRAVITY_METHODS: readonly AntigravityMethodChoice[] = [
  { id: 'oauth-personal', label: 'Google account', detail: 'Sign in with Google in your browser.', usesBrowser: true, needsCloudProject: false },
  { id: 'oauth-business', label: 'Gemini Enterprise', detail: 'Sign in with your work account. Usage goes to a Google Cloud project.', usesBrowser: true, needsCloudProject: true },
  { id: 'gemini-api-key', label: 'Gemini API key', detail: 'Paste a key from Google AI Studio.', usesBrowser: false, needsCloudProject: false },
  { id: 'agent-platform', label: 'Vertex AI', detail: 'Paste a Google Cloud API key, or your Application Default Credentials.', usesBrowser: false, needsCloudProject: true },
]

export const ANTIGRAVITY_CREDENTIAL_PLACEHOLDERS = {
  'gemini-api-key': 'AIza…',
  'agent-platform': 'AIza… or { "type": "authorized_user", … }',
} as const satisfies Record<AntigravityCredential['method'], string>

export interface AntigravityForm {
  method: AntigravityMethod
  gcpProject: string
  gcpLocation: string
  credential: string
}

/** What the form's button does now, or why it cannot. */
export type AntigravityAction =
  | { kind: 'browser'; signIn: AntigravityBrowserSignIn }
  | { kind: 'credential'; token: string; credential: AntigravityCredential }
  | { kind: 'incomplete'; message: string | null }

export function antigravityChoice(method: AntigravityMethod): AntigravityMethodChoice {
  return ANTIGRAVITY_METHODS.find((choice) => choice.id === method)!
}

/** The request the form makes, checked by the host's own schemas so the form says what the host would refuse. */
export function antigravityActionOf(form: AntigravityForm): AntigravityAction {
  const choice = antigravityChoice(form.method)
  if (choice.needsCloudProject && (!form.gcpProject.trim() || !form.gcpLocation.trim())) return { kind: 'incomplete', message: null }
  // The schemas are strict: a method with no project takes no project fields.
  const fields = choice.needsCloudProject ? { method: form.method, gcpProject: form.gcpProject, gcpLocation: form.gcpLocation } : { method: form.method }
  if (choice.usesBrowser) {
    const signIn = antigravityBrowserSignInSchema.safeParse(fields)
    return signIn.success ? { kind: 'browser', signIn: signIn.data } : { kind: 'incomplete', message: signIn.error.issues[0]?.message ?? null }
  }
  if (!form.credential.trim()) return { kind: 'incomplete', message: null }
  const credential = antigravityCredentialSchema.safeParse(fields)
  return credential.success
    ? { kind: 'credential', token: form.credential.trim(), credential: credential.data }
    : { kind: 'incomplete', message: credential.error.issues[0]?.message ?? null }
}
