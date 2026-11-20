import { SvelteSet } from 'svelte/reactivity'
import type { TranscriptDisclosure } from './transcript-disclosure.svelte'

/**
 * The open tool lines of each tool group. Each line opens and closes alone, so
 * several calls of one group can be read at once. They are kept beside the
 * conversation's disclosure, which `ConversationViewState` owns, so they stay
 * after a tab switch. This module is not part of the first screen.
 */
const groupsByDisclosure = new WeakMap<TranscriptDisclosure, Map<string, SvelteSet<string>>>()

/** The disclosure key of the tool group whose first call is `firstToolId`. */
export function toolGroupKey(firstToolId: string | undefined): string {
  return `tools:${firstToolId}`
}

/** The ids of the open lines of one tool group. */
export function openToolLines(disclosure: TranscriptDisclosure, groupKey: string): SvelteSet<string> {
  let groups = groupsByDisclosure.get(disclosure)
  if (!groups) groupsByDisclosure.set(disclosure, (groups = new Map()))
  let lines = groups.get(groupKey)
  if (!lines) groups.set(groupKey, (lines = new SvelteSet()))
  return lines
}

/** Opens a tool group and one of its lines. */
export function openToolLine(disclosure: TranscriptDisclosure, groupKey: string, toolId: string): void {
  disclosure.forKey(groupKey).expanded = true
  openToolLines(disclosure, groupKey).add(toolId)
}
