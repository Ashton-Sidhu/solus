import {
    FileText as FileTextIcon,
    Brain as BrainIcon,
    MessageCircle as MessageCircleIcon,
    Search as MagnifyingGlassIcon,
    Pen as PencilSimpleIcon,
    Terminal as TerminalIcon,
    Wrench as WrenchIcon,
  } from "@lucide/svelte";
  import type { Component } from 'svelte'
import type { AgentActivityKind } from '@solus/contracts/agent-activity'

/** One glyph per kind, stacked in the order the kinds first happened. */
export const KIND_ICONS = {
  think: BrainIcon,
  ask: MessageCircleIcon,
  search: MagnifyingGlassIcon,
  read: FileTextIcon,
  edit: PencilSimpleIcon,
  run: TerminalIcon,
  other: WrenchIcon,
} satisfies Record<AgentActivityKind, Component>
