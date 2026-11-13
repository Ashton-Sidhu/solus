import {
  answerAppCall,
  appCallMessageSchema,
  appResultMessage,
  type APP_DATA_CHANGED_MESSAGE,
  type AppCallMessage,
  type AppResultMessage,
} from '@solus/client-core/app-calls'
import { wrapSandboxDocument } from '@solus/contracts/artifact-sandbox'

/**
 * The app frame on this client (docs/plans/apps.md §9): the shared sandbox
 * document as an app's frame, in a web view. A web view has no `parent`
 * frame, so the page's bridge posts each call to the native side, and the
 * native side posts each answer and each event into the page's own window.
 */

// Without it WebKit lays the page out 980px wide and scales it down.
const VIEWPORT = '<meta name="viewport" content="width=device-width,initial-scale=1">'

/** The document of an app's UI. `network` is the hosts the frame may reach (`AppState.network`). */
export function appDocument(html: string, themeCss: string, network: readonly string[]): string {
  return wrapSandboxDocument(VIEWPORT + html, themeCss, false, { network })
}

/** The call an app's UI posted, or null for any other message. */
export function readAppCall(data: string): AppCallMessage | null {
  try {
    const message = appCallMessageSchema.safeParse(JSON.parse(data))
    return message.success ? message.data : null
  } catch {
    return null
  }
}

/** Script that gives the UI one message of the bridge: the answer to a call, or an event. */
export function appMessageScript(message: AppResultMessage | typeof APP_DATA_CHANGED_MESSAGE): string {
  return `window.postMessage(${JSON.stringify(message)},"*");true;`
}

/**
 * Answers one message of an app's UI. A call runs on the host (`appCall`) and
 * always gets an answer, so the UI never waits: the value, or the reason the
 * host refused. An app never asks the person first (decision 11). Returns the
 * script that gives the UI its answer, or null for a message that is not a call.
 */
export async function relayAppCall(data: string, callHost: (name: string, argumentsJson: string) => Promise<string>): Promise<string | null> {
  const call = readAppCall(data)
  if (!call) return null
  return appMessageScript(await appResultMessage(call.id, answerAppCall(callHost, call.name, call.args)))
}
