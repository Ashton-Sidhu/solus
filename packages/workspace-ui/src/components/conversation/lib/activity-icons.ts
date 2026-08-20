import {
    FileText as FileTextIcon,
    Lightbulb as LightbulbIcon,
    Search as MagnifyingGlassIcon,
    Pen as PencilSimpleIcon,
    Terminal as TerminalIcon,
    Wrench as WrenchIcon,
  } from "@lucide/svelte";
  import type { Component } from 'svelte'
import type { ActivityKind } from './activity-summary'

/** One glyph per kind, stacked in the order the kinds first happened. */
export const KIND_ICONS = {
  think: LightbulbIcon,
  search: MagnifyingGlassIcon,
  read: FileTextIcon,
  edit: PencilSimpleIcon,
  run: TerminalIcon,
  other: WrenchIcon,
} satisfies Record<ActivityKind, Component>
