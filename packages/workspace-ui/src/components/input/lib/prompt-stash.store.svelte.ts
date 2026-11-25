import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import type { IpcContext, Prompt } from '@solus/contracts/types'
import { uuid } from '@solus/contracts/uuid'
import { toasts } from '../../../lib/toasts'
import { accountStore } from '../../../contexts/account/account.store.svelte'
import { attachmentUploads } from './attachment-uploads.svelte'
import {
  hasStashContent, MAX_STASHED_PROMPTS, PromptStash, promptStashKey, restoreStashedPrompt,
  stashAttachmentHost, stashedFileExpired, type PromptStashEntry,
} from './prompt-stash'

const entriesByKey = new SvelteMap<string, PromptStashEntry[]>()
const OPEN_PROMPT_STASH_EVENT = 'solus:open-prompt-stash'

export function openPromptStash(tabId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_PROMPT_STASH_EVENT, { detail: tabId }))
}

export function currentPromptStashKey(organizationId: string | null): string | null {
  if (!accountStore.hasAnswered) return null
  const account = accountStore.state
  const accountId = account.kind === 'signed-in' ? JSON.stringify([account.consoleUrl, account.identity.sub]) : null
  return promptStashKey(accountId, organizationId)
}

function read(key: string): void {
  try {
    entriesByKey.set(key, new PromptStash(localStorage).read(key))
  } catch {
    entriesByKey.delete(key)
  }
}

function take(key: string, id: string): PromptStashEntry | undefined {
  const result = new PromptStash(localStorage).take(key, id)
  entriesByKey.set(key, result.entries)
  return result.entry
}

interface ComposerStashTarget {
  key: string
  prompt: Prompt
  serverId: string
  ctx: IpcContext
}

export function usePromptStash(options: {
  target: () => ComposerStashTarget | null
  tabId: () => string | undefined
  ownsShortcuts: () => boolean
  canStash: () => boolean
  updateEditor: (text: string) => void
}) {
  let menuKey = $state<string | null>(null)
  let menuPrompt: Prompt | null = null
  let isRestoring = $state(false)
  const key = $derived(options.target()?.key)
  const entries = $derived(key ? entriesByKey.get(key) ?? [] : [])
  const open = $derived(!!key && key === menuKey)

  $effect(() => {
    if (key && !entriesByKey.has(key)) read(key)
  })

  $effect(() => {
    if (!key) return
    const refresh = (event: StorageEvent) => {
      if (event.key === key || event.key === null) read(key)
    }
    window.addEventListener('storage', refresh)
    return () => window.removeEventListener('storage', refresh)
  })

  $effect(() => {
    if (!options.ownsShortcuts() || options.target()?.prompt !== menuPrompt) close()
  })

  $effect(() => {
    const tabId = options.tabId()
    if (!tabId || !key) return
    const openForTab = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === tabId && options.ownsShortcuts()) setOpen(true)
    }
    window.addEventListener(OPEN_PROMPT_STASH_EVENT, openForTab)
    return () => window.removeEventListener(OPEN_PROMPT_STASH_EVENT, openForTab)
  })

  function close() {
    menuKey = null
  }

  function setOpen(isOpen: boolean) {
    menuPrompt = options.target()?.prompt ?? null
    menuKey = isOpen ? key ?? null : null
  }

  async function restore(entry: PromptStashEntry): Promise<void> {
    const target = options.target()
    if (!target || isRestoring) return
    if (entry.prompt.attachments.some((attachment) => {
      const owner = stashAttachmentHost(attachment, entry.serverId)
      return owner !== undefined && owner !== target.serverId
    })) {
      toasts.info('Restore this prompt on the host that holds its attachments.')
      return
    }

    isRestoring = true
    try {
      const api = serverConnections.apiFor(target.serverId)
      const originContext = {
        ...target.ctx,
        session: { ...target.ctx.session, sessionId: entry.sessionId, draftId: entry.draftId },
      }
      const now = Date.now()
      const missing = new Set<string>()
      await Promise.all(entry.prompt.attachments.map(async (attachment) => {
        const path = attachment.hostPath
        if (!path || stashAttachmentHost(attachment, entry.serverId) === undefined) return
        if (stashedFileExpired(entry, attachment, now) || !await api.assetFindUrl(originContext, { paths: [path] })) {
          missing.add(attachment.id)
        }
      }))

      const current = options.target()
      if (!current || !options.ownsShortcuts() || current.key !== target.key ||
          current.prompt !== target.prompt || current.serverId !== target.serverId) return

      const saved = take(target.key, entry.id)
      if (!saved) return
      const restored = saved.prompt
      for (const attachment of restored.attachments) {
        if (attachment.type === 'image' && attachment.dataUrl) {
          delete attachment.hostPath
          delete attachment.hostServerId
          attachment.path = attachment.name
        }
        if (missing.has(attachment.id)) attachment.needsReattach = true
      }
      restoreStashedPrompt(current.prompt, restored)
      close()
      options.updateEditor(current.prompt.text)
      if (missing.size) toasts.info('Attach missing files again or remove them before sending.')
    } catch {
      toasts.error('Could not restore this prompt. It is still in the stash.')
    } finally {
      isRestoring = false
    }
  }

  function remove(entry: PromptStashEntry): void {
    if (!key || isRestoring) return
    try {
      take(key, entry.id)
    } catch {
      toasts.error('Could not delete this stashed prompt.')
    }
  }

  function shortcut() {
    const target = options.target()
    if (!target || isRestoring) return
    if (!options.canStash()) {
      setOpen(!open)
      return
    }
    const { prompt, ctx, serverId } = target
    if (attachmentUploads.isPreparing(serverId, ctx) || attachmentUploads.isUploading(prompt.attachments)) {
      toasts.info('Wait for uploads to finish before stashing this prompt.')
      return
    }
    const blocker = attachmentUploads.sendBlocker(prompt.attachments)
    if (blocker) {
      toasts.info(blocker)
      return
    }
    if (!hasStashContent(prompt)) {
      read(target.key)
      if (entries.length === 1) void restore(entries[0])
      else setOpen(!open)
      return
    }

    try {
      const previousCount = entries.length
      entriesByKey.set(target.key, new PromptStash(localStorage).save(target.key, {
        id: uuid(), createdAt: Date.now(), serverId,
        sessionId: ctx.session.sessionId, draftId: ctx.session.draftId,
        prompt,
      }))
      prompt.text = ''
      prompt.attachments.splice(0)
      prompt.planRefs.splice(0)
      prompt.workRefs.splice(0)
      prompt.sessionRefs.splice(0)
      close()
      options.updateEditor('')
      toasts.success(previousCount >= MAX_STASHED_PROMPTS
        ? 'Prompt stashed. The oldest stash was removed.'
        : 'Prompt stashed.')
    } catch {
      toasts.error('Could not save the stash. Your prompt is still in the composer.')
    }
  }

  return {
    get entries() { return entries },
    get open() { return open },
    get isRestoring() { return isRestoring },
    close, setOpen, restore, remove, shortcut,
  }
}
