import { standingAllows } from '@solus/contracts/permissions'
import { suggestionDecisionSchema, suggestionPrompt } from '@solus/contracts/session-suggestions'
import type { PromptImageRef, PromptOptions } from '@solus/contracts/types'
import { z } from 'zod'
import { ownerKeyOf } from '../../admission/actor'
import type { Principal } from '../../admission/principal'
import type { SessionSuggestions } from '../../sharing/session-suggestions'
import type { ShareManager } from '../../sharing/share-manager'
import type { CallerCtx, HandlerCtx, SolusServer } from '../server'

/** Images a provider takes as an image block; any other file goes as a path line, as a composer writes it. */
const PROMPT_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface SuggestionHandlerDeps {
  suggestions: SessionSuggestions
  /** Absent only on the desktop's in-process path before the share manager exists: there, the caller is the owner. */
  shares?: Pick<ShareManager, 'standingFor'>
}

/**
 * Suggestions (docs/plans/custom-roles.md §7). The gate already decided who may
 * call each method: making and withdrawing one takes `drive.propose`, deciding one
 * takes `drive.prompt`. Send runs the suggestion as the decider's own `prompt`
 * call, through the same gate and the same path a typed prompt takes.
 */
export function registerSuggestionHandlers(server: SolusServer, deps: SuggestionHandlerDeps): void {
  const mayPrompt = async (principal: Principal, sessionId: string): Promise<boolean> => {
    if (!deps.shares) return true
    return standingAllows(await deps.shares.standingFor(principal, { kind: 'session', id: sessionId }), 'drive.prompt')
  }
  const nameOf = (handlerCtx: HandlerCtx): string => handlerCtx.actor.user?.displayName ?? 'the owner'

  server.register('sessionSuggestions', async ([ctx], handlerCtx) => {
    const sessionId = ctx.session.sessionId
    if (!sessionId) return []
    const seesAll = await mayPrompt(handlerCtx.principal, sessionId)
    return deps.suggestions.list(sessionId, { key: ownerKeyOf(handlerCtx.actor), seesAll })
  })

  server.register('sessionSuggest', async ([ctx, request], handlerCtx) => {
    const sessionId = ctx.session.sessionId
    if (!sessionId) throw new Error('A suggestion needs a session.')
    const key = ownerKeyOf(handlerCtx.actor)
    if (!key) throw new Error('A suggestion needs a person to come from.')
    return deps.suggestions.suggest(sessionId, { key, name: nameOf(handlerCtx), isGuest: handlerCtx.principal.kind === 'guest' }, request)
  })

  server.register('sessionSuggestionWithdraw', async ([ctx, suggestionId], handlerCtx) => {
    const sessionId = ctx.session.sessionId
    if (!sessionId) return false
    return deps.suggestions.withdraw(sessionId, z.string().min(1).parse(suggestionId), ownerKeyOf(handlerCtx.actor))
  })

  server.register('sessionSuggestionDecide', async ([ctx, suggestionId, decision], handlerCtx) => {
    const sessionId = ctx.session.sessionId
    if (!sessionId) return false
    const id = z.string().min(1).parse(suggestionId)
    if (suggestionDecisionSchema.parse(decision) === 'dismiss') return deps.suggestions.dismiss(sessionId, id, nameOf(handlerCtx))
    const taken = deps.suggestions.take(sessionId, id, nameOf(handlerCtx))
    if (!taken) return false
    const files = taken.attachments.filter((attachment) => !PROMPT_IMAGE_MIME_TYPES.has(attachment.mimeType))
    const images: PromptImageRef[] = taken.attachments
      .filter((attachment) => PROMPT_IMAGE_MIME_TYPES.has(attachment.mimeType))
      .map((attachment) => ({ mimeType: attachment.mimeType, hostPath: attachment.hostPath, name: attachment.name }))
    const text = suggestionPrompt(taken.text, taken.authorName, nameOf(handlerCtx))
    const options: PromptOptions = {
      prompt: files.length ? `${files.map((file) => `[Attached file: ${file.hostPath}]`).join('\n')}\n\n${text}` : text,
      displayPrompt: text,
    }
    if (images.length) options.imageAttachmentRefs = images
    const caller: CallerCtx = { clientId: handlerCtx.clientId, principal: handlerCtx.principal }
    if (handlerCtx.deviceId) caller.deviceId = handlerCtx.deviceId
    try {
      await server.handle('prompt', [ctx, options], caller)
    } catch (error) {
      deps.suggestions.restore(sessionId, id)
      throw error
    }
    return true
  })
}
