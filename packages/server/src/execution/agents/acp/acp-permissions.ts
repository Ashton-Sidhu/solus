import type { PermissionMode } from '@solus/contracts/types'
import type { AcpPermissionRequest, AcpToolKind } from './acp-protocol'

/** What Solus does with one permission request (docs/plans/antigravity-provider.md §5.3). */
export type AcpPermissionAnswer = 'allow' | 'deny' | 'ask'

type ToolGroup = 'look' | 'change' | 'act'

const GROUP_OF_KIND = {
  read: 'look',
  search: 'look',
  fetch: 'look',
  think: 'look',
  edit: 'change',
  delete: 'change',
  move: 'change',
  execute: 'act',
  switch_mode: 'act',
  other: 'act',
} as const satisfies Record<AcpToolKind, ToolGroup>

const ANSWERS = {
  'full-access': { look: 'allow', change: 'allow', act: 'allow' },
  auto: { look: 'allow', change: 'allow', act: 'ask' },
  'accept-edits': { look: 'allow', change: 'allow', act: 'ask' },
  supervised: { look: 'allow', change: 'ask', act: 'ask' },
  plan: { look: 'allow', change: 'deny', act: 'deny' },
} as const satisfies Record<PermissionMode, Record<ToolGroup, AcpPermissionAnswer>>

export function acpPermissionAnswer(mode: PermissionMode, kind: AcpToolKind | null | undefined): AcpPermissionAnswer {
  return ANSWERS[mode][GROUP_OF_KIND[kind ?? 'other']]
}

/** The option that gives `answer` once; a remembered choice only when the agent offers no single one. */
export function acpPermissionOption(options: AcpPermissionRequest['options'], answer: 'allow' | 'deny'): string | null {
  const kinds = answer === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate.kind === kind)
    if (option) return option.optionId
  }
  return null
}
