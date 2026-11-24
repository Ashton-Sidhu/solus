import type { PromptImageRef, PromptOptions } from '@solus/contracts/types'
import { parseUserKey } from '@solus/contracts/user'
import { unattendedActorFor, type Actor } from '../../admission/actor'
import { storeAttachment } from '../../data/assets/attachment-store'
import { organizationOfSession } from '../../data/sessions/session-records'
import { createLogger } from '../../logger'
import type { AgentToolImage } from '../agents/tools/agent-tool'

const log = createLogger('SessionRuntime', 'session-wake.ts')

/** The owners of work outside a turn that start a session's agent again. */
export type WakeVia = Extract<NonNullable<PromptOptions['via']>, 'pull-request-watch' | 'mcp-task' | 'resource-watch'>

/** The device label of a wake's actor, as the automation runner names its own. */
const WAKE_LABELS = {
  'pull-request-watch': 'Pull request watch',
  'mcp-task': 'MCP task',
  'resource-watch': 'Resource watch',
} satisfies { [via in WakeVia]: string }

/** The record that wakes a session: its session, and the person it works for. A null person is the host's own work. */
export interface WakeRecord {
  sessionId: string
  personKey: string | null
  completionWatchId?: string
}

export interface SessionWakeDeps {
  /** Queues the message on the session, after its running turn, as `origin.actor`. */
  prompt: (sessionId: string, text: string, origin: Pick<PromptOptions, 'via' | 'imageAttachmentRefs' | 'clientPromptId'> & { actor?: Actor }) => Promise<void>
  /** The attachment store, for the images of the message; a test passes a temporary folder. */
  attachmentsDir?: string
}

/** A terminal watch turn must finish before auto-settlement, without resetting its clock. */
export function isPullRequestMergeWake(options: Pick<PromptOptions, 'via' | 'clientPromptId'>): boolean {
  return options.via === 'pull-request-watch' && options.clientPromptId?.startsWith('pr-merge-watch:') === true
}

/** A guest's work does not run unattended (plans/019-acting-identity.md): the wake fails, and its owner ends the record. */
export class UnattendedWakeRefusedError extends Error {
  constructor() {
    super('This was started by a guest, and a guest’s work does not run unattended.')
    this.name = 'UnattendedWakeRefusedError'
  }
}

/**
 * The message that starts a session's agent again with news from outside a
 * turn: a pull request watch (docs/plans/pr-watch.md), an MCP task's end
 * (docs/plans/mcp-first-class.md §12), or a change of a watched resource
 * (§11.5). The wake runs as the record's person, also after a host restart, as
 * an automation runs as its creator. A prompt carries an image by its path in
 * the session's attachment store, never as bytes.
 */
export class SessionWake {
  constructor(private readonly deps: SessionWakeDeps) {}

  async send(record: WakeRecord, via: WakeVia, text: string, images: AgentToolImage[] = []): Promise<void> {
    const actor = await this.actorOf(record, via)
    const origin: Parameters<SessionWakeDeps['prompt']>[2] = { via, actor }
    if (record.completionWatchId) origin.clientPromptId = `pr-merge-watch:${record.completionWatchId}`
    if (images.length) origin.imageAttachmentRefs = await this.storedImages(record.sessionId, via, images)
    await this.deps.prompt(record.sessionId, text, origin)
  }

  /** Whom the wake runs for. Undefined is the host's own work, or lets the session's live turn name its person. */
  private async actorOf(record: WakeRecord, via: WakeVia): Promise<Actor | undefined> {
    if (record.personKey === null) return undefined
    const user = { id: parseUserKey(record.personKey), displayName: record.personKey }
    const actor = unattendedActorFor(user, await organizationOfSession(record.sessionId), WAKE_LABELS[via])
    if (!actor) throw new UnattendedWakeRefusedError()
    return actor
  }

  /** An image that cannot be stored is left out; the message still goes. */
  private async storedImages(sessionId: string, via: WakeVia, images: AgentToolImage[]): Promise<PromptImageRef[]> {
    const refs: PromptImageRef[] = []
    for (const [index, image] of images.entries()) {
      const name = `${via}-image-${index + 1}.${image.mimeType.slice('image/'.length).replace('jpeg', 'jpg')}`
      try {
        const hostPath = await storeAttachment(sessionId, { name, mime: image.mimeType, dataUrl: `data:${image.mimeType};base64,${image.data}` }, this.deps.attachmentsDir)
        refs.push({ mimeType: image.mimeType, hostPath, name })
      } catch (error) {
        log.warn('session_wake_image_not_stored', { sessionId, via, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return refs
  }
}
