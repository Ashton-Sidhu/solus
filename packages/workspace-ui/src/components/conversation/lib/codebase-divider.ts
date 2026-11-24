import type { Activity } from '@solus/contracts/activity'
import type { Codebase } from '@solus/contracts/codebases'

/**
 * The name in the divider of a codebase that the host made
 * (docs/plans/codebases.md decision 13). The line is as short as each other
 * divider: its words, then the name ("Made codebase solus"). The name is the
 * one that the codebase has now, because a generated name arrives after the
 * formation, and a person can rename the codebase. `current` is the record
 * that this client has for the codebase. Without one (a deleted codebase, a
 * client that did not read its hosts), the line shows the recorded name.
 */
export function codebaseDividerName(activity: Extract<Activity, { kind: 'codebase_formed' }>, current: Pick<Codebase, 'name'> | undefined): string {
  return current?.name ?? activity.name
}
