import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckConclusion, CheckItem } from '@solus/contracts/checks-types'
import type { PrReviewer } from '@solus/contracts/providers'
import { checkVerdict } from '../../packages/workspace-ui/src/components/pr-review/lib/check-verdict'
import { reviewerStateColor } from '../../packages/workspace-ui/src/components/pr-review/lib/reviewer-state'

function check(
  conclusion: CheckConclusion | null,
  inFlight = false,
): CheckItem {
  return {
    id: 'check',
    name: 'Build',
    conclusion,
    inFlight,
    detailsUrl: null,
    appName: null,
    startedAt: null,
    completedAt: null,
  }
}

describe('PR activity rail tones', () => {
  test('exposes a compact icon state for each check result', () => {
    // WHY: the leading icon gives each row a fast scan target. The result word
    // remains available to assistive technology without a redundant column.
    expect(checkVerdict(check('success')).icon).toBe('passed')
    expect(checkVerdict(check(null)).icon).toBe('pending')
    expect(checkVerdict(check(null, true)).icon).toBe('running')
    expect(checkVerdict(check('failure')).icon).toBe('failed')
  })

  test('uses status colour only for reviewers who block the pull request', () => {
    const tone = (state: PrReviewer['state']) => reviewerStateColor(state)

    expect(tone('APPROVED')).toBe('var(--muted-foreground)')
    expect(tone(null)).toBe('var(--muted-foreground)')
    expect(tone('CHANGES_REQUESTED')).toBe('var(--solus-art-negative)')
  })

  test('shows conflict resolution as a solid destructive action', () => {
    // WHY: conflicts block the merge. The action must not look like a neutral
    // secondary control beside that state.
    const source = readFileSync(
      join(
        import.meta.dir,
        '../../packages/workspace-ui/src/components/pr-review/ResolveConflictsButton.svelte',
      ),
      'utf8',
    )

    expect(source).toContain('bg-(--solus-art-negative)')
    expect(source).toContain('text-white')
  })

  test('offers an agent fix only for a failed check', () => {
    const source = readFileSync(
      join(
        import.meta.dir,
        '../../packages/workspace-ui/src/components/pr-review/PrActivityRail.svelte',
      ),
      'utf8',
    )

    expect(source).toContain('verdict.icon === "failed" && onFixCheck')
    expect(source).toContain('<HammerIcon')
    expect(source).toContain('Fix failed check ${item.name} in an agent session')
    expect(source).toContain('w-[48px] shrink-0 whitespace-nowrap')
    expect(source).toContain('text-(--solus-art-negative)')
    expect(source).toContain('class="size-[11px]"')
  })

  test('shows guide preparation immediately after Generate is clicked', () => {
    // WHY: preparing a PR checkout can take long enough to look like a dead
    // click. The activity feed must receive the parent-owned optimistic state
    // before the durable guide queue can publish its first status.
    const reviewPane = readFileSync(
      join(
        import.meta.dir,
        '../../packages/workspace-ui/src/components/pr-review/PrReviewPane.svelte',
      ),
      'utf8',
    )
    const activityFeed = readFileSync(
      join(
        import.meta.dir,
        '../../packages/workspace-ui/src/components/pr-review/ActivityFeed.svelte',
      ),
      'utf8',
    )

    expect(reviewPane).toContain('preparingGuide ? "queued" : guideStatus')
    expect(reviewPane).toContain('generationStatus={visibleGuideStatus}')
    expect(activityFeed).toContain('generationStatus ??')
  })
})
