import type { InlineReviewGuide } from '@solus/contracts/inline-review-guide'
import type { DiffResult } from '@solus/contracts/git-types'
import type { GuideFileRef, ReviewGuideDraft } from '@solus/contracts/review'

export type ReadTurnDiff = (index: number) => Promise<DiffResult | null>

export async function resolveInlineReviewGuide(
  draft: InlineReviewGuide,
  read: ReadTurnDiff,
  split: (patch: string) => Map<string, string>,
) {
  const turns = new Map<number, Map<string, GuideFileRef>>()
  const unavailable = new Set<number>()
  for (const section of draft.sections) {
    for (const { turn, path } of section.files) {
      const files = turns.get(turn) ?? new Map<string, GuideFileRef>()
      files.set(path, { path, additions: 0, deletions: 0 })
      turns.set(turn, files)
    }
  }
  // Read each turn once. Retain only the files that the guide cites.
  for (const [turn, files] of turns) {
    try {
      const diff = await read(turn - 1)
      const patches = diff && split(diff.patch)
      for (const file of files.values()) {
        const patch = patches?.get(file.path)
        if (!patch) {
          unavailable.add(turn)
          continue
        }
        file.hunks = patch
        const start = patch.indexOf('\n@@ ')
        if (start < 0) continue
        for (const line of patch.slice(start).split('\n')) {
          if (line.startsWith('+')) file.additions++
          if (line.startsWith('-')) file.deletions++
        }
      }
    } catch {
      unavailable.add(turn)
    }
  }
  const guide: ReviewGuideDraft = {
    title: draft.title,
    summary: draft.summary,
    sections: draft.sections.map((section, order) => ({
      ...section,
      order,
      id: `section-${order + 1}`,
      files: section.files.map(({ path, turn }) => turns.get(turn)!.get(path)!),
    })),
  }
  return { guide, unavailable: [...unavailable] }
}
