import type { MergeMethod } from '@solus/contracts/types'

/**
 * Which merge the button will make. The rail used to guess the method from
 * whether the PR was blocked, which said "rebase" about a pull request that
 * would have landed as a merge commit.
 *
 * There was a `mergeMethodPhrase` here too, for a "Merges as a merge commit
 * into main" footnote under the button. The button's own label already names
 * the method and changes with it, so the footnote was the control restated;
 * both it and the phrase are gone.
 */

export interface MergeMethodOption {
  value: MergeMethod
  /** What the button says it will do — also the label the project rail's merge row takes. */
  action: string
  label: string
  hint: string
}

/** Preference order, the order the merge menu lists them in, and the one place
 *  a merge method is put into words. */
export const MERGE_METHOD_OPTIONS: MergeMethodOption[] = [
  {
    value: 'merge',
    action: 'Merge pull request',
    label: 'Merge commit',
    hint: 'Keep every commit, plus a merge commit.',
  },
  {
    value: 'squash',
    action: 'Squash and merge',
    label: 'Squash',
    hint: 'Combine everything into one commit.',
  },
  {
    value: 'rebase',
    action: 'Rebase and merge',
    label: 'Rebase',
    hint: 'Replay each commit onto the base branch.',
  },
]

const METHOD_ORDER: MergeMethod[] = MERGE_METHOD_OPTIONS.map((option) => option.value)

/** The method the merge button starts on for the methods a host allows. */
export function defaultMergeMethod(methods: readonly MergeMethod[]): MergeMethod {
  return METHOD_ORDER.find((method) => methods.includes(method)) ?? 'merge'
}
