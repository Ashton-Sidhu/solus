import { z } from 'zod'
import type { Codebase, CodebaseRoot } from '@solus/contracts/codebases'
import { hostPathKey } from '@solus/contracts/host-path'
import { isSameRoot, nextUpdatedAt, rootFor, rootRefusal, rootRefusalText, rootRemovalRefusal } from '@solus/client-core/codebases'
import { getInstallationId } from '../../../admission/auth'
import { recordScopeOf } from '../../../admission/principal'
import { workspaceToolAuthority } from '../../../admission/workspace-tool-authority'
import { getSessionRecord } from '../../../data/sessions/session-records'
import { resolveHomePath } from '../../../platform/paths'
import type { AgentTool } from './agent-tool'
import { asPerson, type PersonCall } from './person-rpc'

/**
 * `list_codebases`, `read_codebase`, `update_codebase`, and `delete_codebase`:
 * the codebases of this host as the person of the turn reads and changes them
 * in Settings → Codebases (docs/plans/codebases.md §9). Each tool sends the
 * RPC that a client sends. A change is a save of a newer copy on this host;
 * each client then gives that copy to the other hosts. A delete is a
 * tombstone. No tool deletes a folder.
 */

/** One folder of a codebase as the tools answer it. */
interface FolderRow {
  path: string
  onThisHost: boolean
  hostId: string
  container: boolean
}

/** One codebase as the tools answer it. */
interface CodebaseRow {
  id: string
  name: string
  updatedAt: string
  folders: FolderRow[]
}

function folderRow(root: CodebaseRoot, installationId: string): FolderRow {
  return { path: root.path, onThisHost: root.installationId === installationId, hostId: root.installationId, container: root.container === true }
}

function codebaseRow(codebase: Codebase, installationId: string): CodebaseRow {
  return { id: codebase.id, name: codebase.name, updatedAt: new Date(codebase.updatedAt).toISOString(), folders: codebase.roots.map((root) => folderRow(root, installationId)) }
}

async function codebaseNamed(call: PersonCall, codebaseId: string): Promise<Codebase | null> {
  return (await call('codebaseList')).find((codebase) => codebase.id === codebaseId) ?? null
}

const notFound = (codebaseId: string) => `No codebase ${codebaseId} on this host. Use list_codebases.`
const codebaseIdField = z.string().trim().min(1).describe('The codebase id, from list_codebases.')

// ─── list_codebases ───

const listFields = {}

export const listCodebasesAgentTool: AgentTool<typeof listFields> = {
  name: 'list_codebases',
  description: 'List the codebases the user sees: id, name, and folders by host. A codebase is two or more projects, or one folder that holds repositories.',
  inputFields: listFields,
  strictInput: true,
  requiresApproval: false,
  execute: (_input, context) => asPerson('list_codebases', context, async (call) => {
    const installationId = getInstallationId()
    const codebases = (await call('codebaseList')).map((codebase) => codebaseRow(codebase, installationId))
    return { ok: true, text: JSON.stringify({ codebases }), format: 'json' }
  }),
}

// ─── read_codebase ───

const readFields = {
  codebase_id: z.string().trim().min(1).optional().describe('The codebase id. Defaults to the codebase of this session.'),
}

/** The codebase of the calling session, as its record holds it. */
async function codebaseOfSession(sessionId: string | undefined): Promise<string | null> {
  const principal = workspaceToolAuthority()
  if (!sessionId || !principal) return null
  return (await getSessionRecord(recordScopeOf(principal), sessionId))?.codebaseId ?? null
}

export const readCodebaseAgentTool: AgentTool<typeof readFields> = {
  name: 'read_codebase',
  description: 'Read one codebase (default: this session\'s): name, folders by host, and the repositories in its folders on this host.',
  inputFields: readFields,
  strictInput: true,
  requiresApproval: false,
  execute: (input, context) => asPerson('read_codebase', context, async (call) => {
    const codebaseId = input.codebase_id ?? await codebaseOfSession(context.sessionId())
    if (!codebaseId) return { ok: false, text: 'This session has no codebase. Give codebase_id, or use list_codebases.' }
    const codebase = await codebaseNamed(call, codebaseId)
    if (!codebase) return { ok: false, text: notFound(codebaseId) }
    const installationId = getInstallationId()
    const onThisHost = codebase.roots.some((root) => root.installationId === installationId)
    const members = onThisHost ? await call('codebaseMembers', codebase.id) : []
    return { ok: true, format: 'json', text: JSON.stringify({
      ...codebaseRow(codebase, installationId),
      members: members.map((member) => ({ path: member.path, name: member.name, state: member.state, repository: member.repositoryKey, found: member.discovered })),
    }) }
  }),
}

// ─── update_codebase ───

const updateFields = {
  codebase_id: codebaseIdField,
  name: z.string().trim().min(1).max(200).optional().describe('The new name.'),
  add_folders: z.array(z.string().trim().min(1)).max(32).optional().describe('Folders on this host to add. A folder that holds two or more repositories, and is not one, covers each of them.'),
  remove_folders: z.array(z.string().trim().min(1)).max(32).optional().describe('Folder paths to remove from the codebase. The folders stay on disk.'),
}

/** The root that a path names: one on this host first, else the one root on any host with that path. */
function rootNamed(roots: readonly CodebaseRoot[], path: string, installationId: string): CodebaseRoot | 'none' | 'several' {
  const matches = roots.filter((root) => hostPathKey(root.path) === hostPathKey(path))
  const here = matches.find((root) => root.installationId === installationId)
  if (here) return here
  if (matches.length === 0) return 'none'
  return matches.length === 1 ? matches[0]! : 'several'
}

export const updateCodebaseAgentTool: AgentTool<typeof updateFields> = {
  name: 'update_codebase',
  description: 'Rename a codebase, add folders on this host, or remove folders. It must keep two folders, or one folder that holds repositories. No folder is deleted on disk.',
  inputFields: updateFields,
  strictInput: true,
  requiresApproval: true,
  execute: (input, context) => asPerson('update_codebase', context, async (call) => {
    const current = await codebaseNamed(call, input.codebase_id)
    if (!current) return { ok: false, text: notFound(input.codebase_id) }
    const installationId = getInstallationId()
    const roots = [...current.roots]
    for (const path of input.add_folders ?? []) {
      // The host scans the folder: the root keeps the resolved path and the container mark.
      const scan = await call('codebaseScanFolder', resolveHomePath(path))
      const root = rootFor(installationId, scan)
      const refusal = scan.state === 'missing' ? 'missing' : rootRefusal(roots, root)
      if (refusal) return { ok: false, text: `${path}: ${rootRefusalText(refusal)}` }
      roots.push(root)
    }
    for (const path of input.remove_folders ?? []) {
      const root = rootNamed(roots, resolveHomePath(path), installationId)
      if (root === 'none') return { ok: false, text: `${path} is not a folder of this codebase.` }
      if (root === 'several') return { ok: false, text: `${path} is a folder of this codebase on more than one host. Remove it in Settings → Codebases.` }
      const refusal = rootRemovalRefusal(roots, root)
      if (refusal) return { ok: false, text: `${path}: ${rootRefusalText(refusal)}` }
      roots.splice(roots.findIndex((existing) => isSameRoot(existing, root)), 1)
    }
    const name = input.name ?? current.name
    const sameRoots = roots.length === current.roots.length && roots.every((root, index) => root === current.roots[index])
    if (name === current.name && sameRoots) return { ok: true, text: JSON.stringify(codebaseRow(current, installationId)), format: 'json' }
    const next: Codebase = { ...current, name, roots, updatedAt: nextUpdatedAt(current, Date.now()) }
    const kept = await call('codebaseSave', next)
    if (kept.updatedAt !== next.updatedAt) return { ok: false, text: 'A newer copy of this codebase came from a different host. Read it again with read_codebase, then try again.' }
    return { ok: true, text: JSON.stringify(codebaseRow(kept, installationId)), format: 'json' }
  }),
}

// ─── delete_codebase ───

const deleteFields = { codebase_id: codebaseIdField }

export const deleteCodebaseAgentTool: AgentTool<typeof deleteFields> = {
  name: 'delete_codebase',
  description: 'Delete one codebase. Its folders, projects, and sessions stay.',
  inputFields: deleteFields,
  strictInput: true,
  requiresApproval: true,
  execute: (input, context) => asPerson('delete_codebase', context, async (call) => {
    const current = await codebaseNamed(call, input.codebase_id)
    if (!current) return { ok: false, text: notFound(input.codebase_id) }
    const deletedAt = nextUpdatedAt(current, Date.now())
    const kept = await call('codebaseSave', { ...current, updatedAt: deletedAt, deletedAt })
    if (kept.deletedAt === null) return { ok: false, text: 'A newer copy of this codebase came from a different host. Read it again with read_codebase, then try again.' }
    return { ok: true, text: JSON.stringify({ id: kept.id, deleted: true, foldersKept: true }), format: 'json' }
  }),
}
