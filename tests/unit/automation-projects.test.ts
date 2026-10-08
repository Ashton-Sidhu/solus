import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { describe, expect, test } from 'bun:test'
import type { Automation } from '@solus/contracts/types'
import { localProjectKey } from '@solus/contracts/repository-key'
import {
  automationProjectKey,
  automationProjectOptions,
  automationsInScope,
} from '@solus/workspace-ui/components/automations/lib/automation-projects'
import { projectOptionsFor, type LogicalProject } from '@solus/workspace-ui/contexts/projects/project-catalog'

function automation(id: string, cwd: string): Automation {
  return {
    id,
    name: id,
    enabled: true,
    action: {
      prompt: 'Run checks',
      agentProvider: 'codex',
      modelId: null,
      reasoningEffort: 'medium',
      cwd,
    },
    trigger: { type: 'manual' },
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    createdBy: { kind: 'system' },
  }
}

describe('automation project filter', () => {
  const checkout = (serverId: string, projectRoot: string, repositoryKey: string | null) =>
    ({ serverId, projectRoot, label: projectRoot.split('/').at(-1)!, lastSeenAt: 1, repositoryKey })
  const catalog: LogicalProject[] = [
    { key: 'github.com/acme/solus', label: 'solus', cloudProject: null, checkouts: [checkout('laptop', '/repos/solus', 'github.com/acme/solus'), checkout('studio', '/srv/solus', 'github.com/acme/solus')] },
    { key: 'github.com/fork/solus', label: 'solus', cloudProject: null, checkouts: [checkout('laptop', '/forks/solus', 'github.com/fork/solus')] },
    { key: 'github.com/acme/tools', label: 'tools', cloudProject: null, checkouts: [checkout('laptop', '/repos/tools', 'github.com/acme/tools')] },
  ]
  // The projects store's rule: a checkout it holds names its repository; any
  // other folder is its own local-only project.
  const projectKeyFor = (serverId: string, path: string) => {
    const entry = catalog.flatMap((project) => project.checkouts).find((c) => c.serverId === serverId && path.startsWith(c.projectRoot))
    return entry?.repositoryKey ?? localProjectKey(serverId, path)
  }
  const optionsFor = (keys: Iterable<string>) => projectOptionsFor(keys, catalog, () => true, (serverId) => serverId.toUpperCase(), null)
  const hostOf = new Map<string, string>()
  const placed = (id: string, serverId: string, cwd: string) => {
    hostOf.set(id, serverId)
    return automation(id, cwd)
  }
  const keyOf = (row: Automation) => automationProjectKey(row.action.cwd, hostOf.get(row.id) ?? null, projectKeyFor)

  test('one repository on two hosts is one row, and its scope shows the automations of both', () => {
    // WHY: a project is the repository, not one host's checkout of it.
    const rows = [placed('laptop-row', 'laptop', '/repos/solus'), placed('studio-row', 'studio', '/srv/solus')]
    const options = automationProjectOptions(rows.map(keyOf), [], optionsFor)
    expect(options.map(({ key, label }) => ({ key, label }))).toEqual([{ key: 'github.com/acme/solus', label: 'solus' }])
    const scoped = automationsInScope(rows, { kind: 'project', key: 'github.com/acme/solus', checkout: null }, keyOf)
    expect(scoped.map((row) => row.id)).toEqual(['laptop-row', 'studio-row'])
  })

  test('two repositories with one name read as two names', () => {
    const rows = [placed('a', 'laptop', '/repos/solus'), placed('b', 'laptop', '/forks/solus')]
    const options = automationProjectOptions(rows.map(keyOf), [], optionsFor)
    expect(options.map((option) => option.label)).toEqual(['acme/solus', 'fork/solus'])
  })

  test('keeps one folder on two hosts apart when no repository joins them', () => {
    const rows = [placed('a', 'laptop', '/scratch/notes'), placed('b', 'studio', '/scratch/notes')]
    const options = automationProjectOptions(rows.map(keyOf), [], optionsFor)
    expect(options.map((option) => option.label)).toEqual(['notes · LAPTOP', 'notes · STUDIO'])
  })

  test('a project with no automation yet is offered, and is the row the selector may forget', () => {
    const rows = [placed('a', 'laptop', '/repos/solus')]
    const options = automationProjectOptions(rows.map(keyOf), ['github.com/acme/tools'], optionsFor)
    expect(options.map(({ key, removable }) => ({ key, removable }))).toEqual([
      { key: 'github.com/acme/solus', removable: false },
      { key: 'github.com/acme/tools', removable: true },
    ])
  })

  test('a project added from "Add project…" scopes the page by its project key', () => {
    // WHY: the added row carries the logical key. The page once looked it up
    // as a host checkout key, missed, and fell back to every project.
    const added = 'github.com/acme/tools'
    const rows = [placed('tools-row', 'laptop', '/repos/tools/sub'), placed('other', 'laptop', '/repos/solus')]
    const options = automationProjectOptions(rows.map(keyOf), [added], optionsFor)
    expect(options.some((option) => option.key === added)).toBe(true)
    const scoped = automationsInScope(rows, { kind: 'project', key: added, checkout: null }, keyOf)
    expect(scoped.map((row) => row.id)).toEqual(['tools-row'])
  })

  test('automations with no project file under one "Chat" choice', () => {
    // WHY: each run of such an automation gets a new chat folder, so the saved
    // marker is what they share, and it must read as a chat, not a path.
    const rows = [placed('a', 'laptop', NEW_CHAT_DIRECTORY), placed('b', 'studio', NEW_CHAT_DIRECTORY)]
    const options = automationProjectOptions(rows.map(keyOf), [], optionsFor)
    expect(options.map(({ key, label }) => ({ key, label }))).toEqual([{ key: NEW_CHAT_DIRECTORY, label: 'Chat' }])
    expect(automationsInScope(rows, { kind: 'project', key: NEW_CHAT_DIRECTORY, checkout: null }, keyOf)).toHaveLength(2)
  })
})
