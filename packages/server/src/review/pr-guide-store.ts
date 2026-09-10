import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { reviewGuideKeyForTarget, type ReviewGuide } from '@solus/contracts/review'
import { projectScopeOf, type IpcContext } from '@solus/contracts/types'
import { providerForRepo } from '../providers/registry'
import { dataDir } from '../platform/paths'
import { resolveRepoRef } from '../git/git-helpers'
import { readGuideByKey } from './ledger'
import { managedPrCheckoutPath } from './managed-pr-checkout'
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

export async function readPrGuide(ctx: IpcContext, target: PrGuideTarget): Promise<ReviewGuide | null> {
  const saved = await readJson<ReviewGuide>(prGuidePath(target))
  if (saved) return saved
  const guides = await readPriorPrGuides(target)
  if (guides.length) return promoteLegacyPrGuide(target, guides)

  // Compatibility only: old releases saved either the PR key or its checkout
  // branch. Read known repository locations, including stacked base variants.
  // A successful regeneration replaces this logical guide in canonical storage.
  const roots = new Set([ctx.session.gitContext?.repoRoot, projectScopeOf(ctx.session)])
  const keys = new Set([prGuideKey(target), legacyPrGuideKey(target), `solus__pr-${target.number}`, `solus__review__pr-${target.number}`])
  if (target.baseSha && target.headSha) roots.add(managedPrCheckoutPath(target, {
    ...target, baseSha: target.baseSha, headSha: target.headSha,
  }))
  try {
    const provider = providerForRepo(target)
    const detail = await provider?.review.getPullRequest(target, target.number)
    if (detail) keys.add(detail.headRef.replace(/\//g, '__'))
  } catch {
    // An offline read can still recover a known cached PR guide.
  }
  for (const root of roots) {
    if (!root || root === '~') continue
    const repository = await resolveRepoRef(root).catch(() => null)
    if (!repository || prGuideRepository({ ...target, ...repository }) !== prGuideRepository(target)) continue
    const variants = new Set(keys)
    for (const directory of [dirname(reviewGuidePath(root, prGuideKey(target))), join(root, '.solus', 'review')]) {
      const names = await readdir(directory).catch(() => [])
      for (const name of names) {
        if (name.endsWith('.json') && [...keys].some((key) => name.startsWith(`${key}--base-`))) {
          variants.add(name.slice(0, -5))
        }
      }
    }
    for (const key of variants) {
      const guide = await readGuideByKey(root, key)
      if (guide) guides.push(guide)
    }
  }
  return promoteLegacyPrGuide(target, guides)
}

async function promoteLegacyPrGuide(target: PrGuideTarget, guides: ReviewGuide[]): Promise<ReviewGuide | null> {
  const latest = guides.sort((a, b) => Date.parse(b.generatedAt ?? '') - Date.parse(a.generatedAt ?? ''))[0]
  if (!latest) return null
  const recordedTarget: PrGuideTarget = { ...target, baseSha: latest.baseSha, headSha: latest.headSha }
  const migrated: ReviewGuide = {
    ...latest, key: prGuideKey(target),
    target: recordedTarget,
  }
  // Never replace a generation that completed during this compatibility read.
  await writePrGuide(migrated, recordedTarget, () => !existsSync(prGuidePath(target)))
  return await readJson<ReviewGuide>(prGuidePath(target)) ?? migrated
}

export async function writePrGuide(guide: ReviewGuide, target: PrGuideTarget, canCommit: () => boolean): Promise<boolean> {
  return writeJsonAtomic(prGuidePath(target), { ...guide, key: prGuideKey(target), target }, 'PR guide', canCommit)
}

function legacyPrGuideKey(target: PrGuideTarget): string {
  return `pr-${target.host}-${target.owner}-${target.repo}-${target.number}`.replace(/[^a-zA-Z0-9._-]/g, '-')
}

/** Earlier managed checkouts embedded the revision in their directory. Their
 * hashed storage root cannot be derived from the new revision; locate only
 * this PR's named file in the retired cache directories. */
async function readPriorPrGuides(target: PrGuideTarget): Promise<ReviewGuide[]> {
  const root = join(dataDir(), 'review-guides')
  const directories = await readdir(root).catch(() => [])
  const keys = new Set([prGuideKey(target), legacyPrGuideKey(target)])
  const unambiguousLegacy = /^[a-zA-Z0-9._]+$/.test(target.owner) && /^[a-zA-Z0-9._]+$/.test(target.repo)
    && target.host.toLowerCase() === 'github.com'
  const guides: ReviewGuide[] = []
  for (const directory of directories) {
    for (const key of keys) {
      const guide = await readJson<ReviewGuide>(join(root, directory, `${key}.json`))
      if (!guide) continue
      const declared = guide.target?.kind === 'pr' ? guide.target : null
      if (declared ? prGuideKey(declared) === prGuideKey(target) : unambiguousLegacy) guides.push(guide)
    }
  }
  return guides
}
