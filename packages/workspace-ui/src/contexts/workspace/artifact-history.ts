import { z } from 'zod'
import type { Message, Work, WorkMeta } from '@solus/contracts/types'
import type { WorksStore } from '../works/works.store.svelte'
import type { DeferredToolInput, WireSessionLoadMessage } from '@solus/contracts/session-history'
import type { HostApi } from '@solus/client-core/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { resolveArtifactTitle } from '@solus/contracts/work-preview'
import { nextMsgId } from './session.utils'

const updateInput = z.object({ work_id: z.string(), content: z.string().optional(), html_path: z.string().optional(), title: z.string().optional() })

/** Restore successful work cards and artifact previews from tool input. Explicit failures and running
 * calls do not become completed previews. Never use today's work content. A call
 * that named an `html_path` has no HTML in its input: `fileBody` is the revision
 * that call wrote (`loadArtifactFileBodies`). */
export function workUpdateFromHistory(
  tool: WireSessionLoadMessage,
  result: WireSessionLoadMessage,
  getWork: (workId: string) => Pick<WorkMeta, 'type' | 'title'> | undefined,
  fileBody?: string,
): Message | undefined {
  if (result.status === 'error' || tool.toolStatus === 'error' || tool.toolStatus === 'running') return
  try {
    const input = updateInput.parse(JSON.parse(tool.toolInput || '{}'))
    const work = getWork(input.work_id)
    if (result.workUpdateSucceeded && !result.artifactWorkRef && work?.type !== 'artifact') {
      return {
        id: nextMsgId(), role: 'assistant', content: '',
        workRef: { workId: input.work_id, title: input.title ?? work?.title ?? 'Work', workType: work?.type ?? 'doc', contentVersion: result.workContentVersion },
        timestamp: result.timestamp ?? tool.timestamp ?? Date.now(),
      }
    }
    return artifactUpdateMessage(input, tool, result, work, fileBody)
  } catch { return undefined }
}

function artifactUpdateMessage(
  input: z.infer<typeof updateInput>,
  tool: WireSessionLoadMessage,
  result: WireSessionLoadMessage,
  work: Pick<WorkMeta, 'type' | 'title'> | undefined,
  fileBody?: string,
): Message | undefined {
  const html = input.html_path ? fileBody : input.content
  if (html === undefined) return
  const ref = result.artifactWorkRef ?? (work?.type === 'artifact'
    ? { workId: input.work_id, title: input.title ?? resolveArtifactTitle(undefined, html), contentVersion: result.workContentVersion }
    : undefined)
  if (!ref || ref.workId !== input.work_id) return
  return {
    id: nextMsgId(), role: 'assistant', content: '',
    artifact: { kind: 'html', html },
    workRef: { workId: ref.workId, title: ref.title, workType: 'artifact', contentVersion: ref.contentVersion },
    timestamp: result.timestamp ?? tool.timestamp ?? Date.now(),
  }
}

const htmlPathInput = z.object({ html_path: z.string() })

/**
 * The HTML each `html_path` artifact call in a page wrote, by tool id. The
 * host read the file, so the transcript holds only the path. Every agent write
 * keeps a revision at the content version the receipt names; this reads that
 * revision from the work's owner, which Share can move off the session's host.
 * A call whose revision cannot be read is left out, and its card is not rebuilt.
 */
export async function loadArtifactFileBodies(
  bodyAtVersion: (workId: string, contentVersion: number) => Promise<string | null>,
  history: WireSessionLoadMessage[],
): Promise<Map<string, string>> {
  const results = new Map(history.flatMap((message) =>
    message.role === 'tool_result' && message.toolResultForId ? [[message.toolResultForId, message] as const] : [],
  ))
  const wanted: { toolId: string; workId: string; contentVersion: number }[] = []
  for (const message of history) {
    if (message.role !== 'tool' || !message.toolId || !message.toolInput?.includes('"html_path"')) continue
    if (!message.toolName?.endsWith('render_artifact') && !message.toolName?.endsWith('update_work')) continue
    if (!namesHtmlPath(message.toolInput)) continue
    const ref = (results.get(message.toolId) ?? message).artifactWorkRef
    if (!ref?.contentVersion) continue
    wanted.push({ toolId: message.toolId, workId: ref.workId, contentVersion: ref.contentVersion })
  }
  const bodies = new Map<string, string>()
  await Promise.all(wanted.map(async ({ toolId, workId, contentVersion }) => {
    const body = await bodyAtVersion(workId, contentVersion).catch(() => null)
    if (body !== null) bodies.set(toolId, body)
  }))
  return bodies
}

function namesHtmlPath(toolInput: string): boolean {
  try { return htmlPathInput.safeParse(JSON.parse(toolInput)).success } catch { return false }
}

const inputHtml = z.object({ html: z.string() })
const htmlReads = new WeakMap<Message, Promise<void>>()

interface ArtifactHtmlSources {
  /** The work as it is now, one cached read: its body is the one a call wrote
   *  when the version still matches. */
  currentWork?(workId: string): Promise<Pick<Work, 'content' | 'contentVersion'> | null>
  bodyAtVersion(workId: string, contentVersion: number, likelyServerId?: string): Promise<string | null>
  apiFor?(serverId: string): Pick<HostApi, 'loadSessionToolInputs'>
}

/** The works store as the HTML sources of a transcript's artifacts. */
export function worksArtifactHtmlSources(works: Pick<WorksStore, 'ensureContent' | 'history'>): ArtifactHtmlSources {
  return {
    currentWork: (workId) => works.ensureContent(workId, 'transcript-artifact'),
    bodyAtVersion: (workId, contentVersion, serverId) => works.history.bodyAtVersion(workId, contentVersion, serverId),
  }
}

/**
 * Fill in the HTML a history page left on its host (`historyHtml`), on the
 * reactive message, when its frame mounts. The work's revision at the version
 * the receipt names comes first: it is a small read the works store caches.
 * The call's own input, read from the transcript, answers when the work cannot
 * (deleted, or moved to a host this client does not reach).
 */
export function loadArtifactHtml(message: Message, sources: ArtifactHtmlSources): Promise<void> {
  const pending = htmlReads.get(message)
  if (pending) return pending
  const ref = message.artifact?.historyHtml
  if (!ref) return Promise.resolve()
  const read = (async () => {
    ref.loading = true
    delete ref.error
    try {
      const version = message.workRef?.contentVersion
      let fromWork: string | null = null
      if (message.workRef && version) {
        const workId = message.workRef.workId
        const current = await sources.currentWork?.(workId).catch(() => null)
        fromWork = current?.contentVersion === version
          ? current.content
          : await sources.bodyAtVersion(workId, version, ref.serverId).catch(() => null)
      }
      const html = fromWork ?? await inputHtmlOf(ref, sources)
      if (message.artifact?.historyHtml !== ref) return
      if (html === null) {
        ref.error = 'This artifact is no longer available.'
        return
      }
      message.artifact.html = html
      delete message.artifact.historyHtml
    } catch {
      ref.error = 'Could not load this artifact.'
    } finally {
      ref.loading = false
      htmlReads.delete(message)
    }
  })()
  htmlReads.set(message, read)
  return read
}

async function inputHtmlOf(ref: DeferredToolInput, sources: ArtifactHtmlSources): Promise<string | null> {
  const api = sources.apiFor ? sources.apiFor(ref.serverId) : serverConnections.apiFor(ref.serverId)
  const [input] = await api.loadSessionToolInputs({
    sessionId: ref.sessionId, projectPath: ref.projectPath, provider: ref.provider, keys: [ref.key],
  })
  if (!input) return null
  try {
    const parsed = inputHtml.safeParse(JSON.parse(input.toolInput))
    return parsed.success ? parsed.data.html : null
  } catch {
    return null
  }
}
