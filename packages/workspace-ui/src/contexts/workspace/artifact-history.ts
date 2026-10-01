import { z } from 'zod'
import type { Message, WorkMeta } from '@solus/contracts/types'
import type { WireSessionLoadMessage } from '@solus/contracts/session-history'
import { resolveArtifactTitle } from '@solus/contracts/work-preview'
import { nextMsgId } from './session.utils'

const updateInput = z.object({ work_id: z.string(), content: z.string().optional(), html_path: z.string().optional(), title: z.string().optional() })

/** Rebuild from tool input, as for initial renders. Explicit failures and running
 * calls do not become completed previews. Never use today's work content. A call
 * that named an `html_path` has no HTML in its input: `fileBody` is the revision
 * that call wrote (`loadArtifactFileBodies`). */
export function artifactUpdateFromHistory(
  tool: WireSessionLoadMessage,
  result: WireSessionLoadMessage,
  getWork: (workId: string) => Pick<WorkMeta, 'type'> | undefined,
  fileBody?: string,
): Message | undefined {
  if (result.status === 'error' || tool.toolStatus === 'error' || tool.toolStatus === 'running') return
  try {
    const input = updateInput.parse(JSON.parse(tool.toolInput || '{}'))
    const html = input.html_path ? fileBody : input.content
    if (html === undefined) return
    const work = result.artifactWorkRef ? undefined : getWork(input.work_id)
    const ref = result.artifactWorkRef ?? (work?.type === 'artifact'
      ? { workId: input.work_id, title: input.title ?? resolveArtifactTitle(undefined, html) }
      : undefined)
    if (!ref || ref.workId !== input.work_id) return
    return {
      id: nextMsgId(), role: 'assistant', content: '',
      artifact: { kind: 'html', html },
      workRef: { workId: ref.workId, title: ref.title, workType: 'artifact' },
      timestamp: result.timestamp ?? tool.timestamp ?? Date.now(),
    }
  } catch { return undefined }
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
