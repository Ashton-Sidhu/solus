import type { PromptImageRef } from '@solus/contracts/types'
import { storeAttachment } from '../data/assets/attachment-store'
import type { AgentToolImage } from '../execution/agents/tools/agent-tool'
import { createLogger } from '../logger'
import { errorText } from './upstream-session'

const log = createLogger('integrations', 'session-wake.ts')

export interface SessionWakeDeps {
  /** Queues the message that starts the session's agent again. */
  wake: (sessionId: string, text: string, images: PromptImageRef[]) => Promise<void>
  /** The attachment store, for the images of the message; a test passes a temporary folder. */
  attachmentsDir?: string
}

/**
 * The message that starts a session's agent again with the end of background
 * work: an MCP task's end (docs/plans/mcp-first-class.md §12) or a change of
 * a watched resource (§11.5). A prompt carries an image by its path in the
 * session's attachment store, never as bytes.
 */
export class SessionWake {
  /** `imageName` names the stored images: `<imageName>-1.png`, and so on. */
  constructor(private readonly deps: SessionWakeDeps, private readonly imageName: string) {}

  async send(sessionId: string, text: string, images: AgentToolImage[]): Promise<void> {
    await this.deps.wake(sessionId, text, await this.storedImages(sessionId, images))
  }

  /** An image that cannot be stored is left out; the message still goes. */
  private async storedImages(sessionId: string, images: AgentToolImage[]): Promise<PromptImageRef[]> {
    const refs: PromptImageRef[] = []
    for (const [index, image] of images.entries()) {
      const name = `${this.imageName}-${index + 1}.${image.mimeType.slice('image/'.length).replace('jpeg', 'jpg')}`
      try {
        const hostPath = await storeAttachment(sessionId, { name, mime: image.mimeType, dataUrl: `data:${image.mimeType};base64,${image.data}` }, this.deps.attachmentsDir)
        refs.push({ mimeType: image.mimeType, hostPath, name })
      } catch (error) {
        log.warn('integration_wake_image_not_stored', { sessionId, imageName: this.imageName, error: errorText(error) })
      }
    }
    return refs
  }
}

/** Text as one line of at most `max` characters. */
export function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
