import { reviewGuideKeyForTarget, type ReviewGuide } from '@solus/contracts/review'
import type { PrGuideTarget } from './pr-guide-context'
import { readJson, reviewGuidePath, writeJsonAtomic } from './review-store'

/** A PR belongs to its remote repository, not the checkout used to read it. */
export function prGuideRepository(target: PrGuideTarget): string {
  return `pr:${target.host.toLowerCase()}/${target.owner.toLowerCase()}/${target.repo.toLowerCase()}`
}

export function prGuideKey(target: PrGuideTarget): string {
  return reviewGuideKeyForTarget(target, '', null)
}

export function prGuidePath(target: PrGuideTarget): string {
  return reviewGuidePath(prGuideRepository(target), prGuideKey(target))
}

export function readPrGuide(target: PrGuideTarget): Promise<ReviewGuide | null> {
  return readJson<ReviewGuide>(prGuidePath(target))
}

export async function writePrGuide(guide: ReviewGuide, target: PrGuideTarget, canCommit: () => boolean): Promise<boolean> {
  return writeJsonAtomic(prGuidePath(target), { ...guide, key: prGuideKey(target), target }, 'PR guide', canCommit)
}
