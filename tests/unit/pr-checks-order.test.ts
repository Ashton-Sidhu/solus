import { describe, expect, test } from 'bun:test'
import { orderedChecks } from '@solus/workspace-ui/components/prs/lib/checks'
import type { CheckConclusion, CheckItem, PrChecksSummary } from '@solus/contracts/checks-types'

function check(
  name: string,
  conclusion: CheckConclusion | null,
  inFlight = false,
): CheckItem {
  return {
    id: name,
    name,
    conclusion,
    inFlight,
    detailsUrl: null,
    appName: null,
    startedAt: null,
    completedAt: null,
  }
}

function summary(required: CheckItem[], optional: CheckItem[] = []): PrChecksSummary {
  return {
    headSha: 'head',
    state: 'failing',
    required,
    optional,
    inFlight: required.some((item) => item.inFlight),
  }
}

describe('rail check ordering', () => {
  // The rail previews only the first CHECKS_PREVIEW rows and collapses the rest.
  // If the host's own order survived, a PR with a long matrix would show four
  // green rows and hide the one thing the reviewer opened the rail to find.
  test('a failure is never buried behind passing checks in the preview', () => {
    const ordered = orderedChecks(
      summary(
        [
          check('lint', 'success'),
          check('unit', 'success'),
          check('typecheck', 'success'),
          check('build', 'success'),
          check('e2e', 'failure'),
        ],
        [check('bundle-size', 'timed_out')],
      ),
    )

    expect(ordered.slice(0, 2).map((item) => item.name)).toEqual(['e2e', 'bundle-size'])
  })

  // Running checks outrank settled ones: "still deciding" is the reviewer's cue
  // to wait, and it disappears on its own — a passing row never will.
  test('in-flight checks sit between failures and settled passes', () => {
    const ordered = orderedChecks(
      summary([
        check('lint', 'success'),
        check('deploy', null, true),
        check('unit', 'failure'),
      ]),
    )

    expect(ordered.map((item) => item.name)).toEqual(['unit', 'deploy', 'lint'])
  })

  // Within a tier the host's order is meaningful (required gate first, then the
  // repo's declared order), so the sort must not scramble it.
  test('ties keep required before optional and the provider order within each', () => {
    const ordered = orderedChecks(
      summary(
        [check('required-a', 'success'), check('required-b', 'skipped')],
        [check('optional-a', 'neutral'), check('optional-b', 'success')],
      ),
    )

    expect(ordered.map((item) => item.name)).toEqual([
      'required-a',
      'required-b',
      'optional-a',
      'optional-b',
    ])
  })

  test('no summary yet renders an empty list rather than throwing', () => {
    expect(orderedChecks(undefined)).toEqual([])
  })
})
