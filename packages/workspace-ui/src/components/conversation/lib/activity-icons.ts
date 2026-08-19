import {
  FileTextIcon,
  LightbulbIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  TerminalIcon,
  WrenchIcon,
} from 'phosphor-svelte'
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
