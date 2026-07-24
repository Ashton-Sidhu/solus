import type { FileDiffMetadata } from '@pierre/diffs'

export type DiffNarrativeGroup = 'entry' | 'core' | 'test' | 'config'

const ENTRY_PATH = /(^|\/)(?:app|bootstrap|client|entry|index|main|server)\.[^/]+$/i
const TEST_PATH = /(^|\/)(?:__tests__|test|tests|spec|specs)(\/|$)|(?:^|\.)((?:test|spec))\.[^/]+$/i
const CONFIG_PATH = /(^|\/)(?:\.[^/]+|[^/]*(?:config|rc)\.[^/]+|dockerfile|makefile|package\.json|tsconfig[^/]*\.json|vite\.config\.[^/]+)$/i

export function diffNarrativeGroup(path: string): DiffNarrativeGroup {
  if (TEST_PATH.test(path)) return 'test'
  if (ENTRY_PATH.test(path)) return 'entry'
  if (CONFIG_PATH.test(path) || /(?:^|\/)(?:bun\.lock|cargo\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(path)) {
    return 'config'
  }
  return 'core'
}

const GROUP_RANK: Record<DiffNarrativeGroup, number> = {
  entry: 0,
  core: 1,
  test: 2,
  config: 3,
}

/** Stable category sort: preserve git/guide order inside each narrative group. */
export function orderDiffFiles(files: FileDiffMetadata[]): FileDiffMetadata[] {
  return files
    .map((file, index) => ({ file, index, rank: GROUP_RANK[diffNarrativeGroup(file.name)] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ file }) => file)
}
