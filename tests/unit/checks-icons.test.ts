import { describe, expect, test } from 'bun:test'
import type { CheckItem } from '@solus/contracts/checks-types'
import { CHECKS_ICON, checkItemIcon } from '@solus/workspace-ui/components/prs/lib/checks-icons'
import {
  CheckCircleFillIcon,
  DotFillIcon,
  SkipFillIcon,
  XCircleFillIcon,
} from '@solus/workspace-ui/components/ui/octicons'

function check(overrides: Partial<CheckItem>): CheckItem {
  return {
    id: 'unit',
    name: 'unit',
    conclusion: 'success',
    inFlight: false,
    detailsUrl: null,
    appName: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  }
}

// The git section and the PRs page draw checks with GitHub's own Octicons: a
// filled circle with a check, a filled circle with a cross, and a solid dot
// while they run.
describe('checks icons', () => {
  test('the rolled-up state uses the GitHub glyphs, with a still dot while checks run', () => {
    expect(CHECKS_ICON.passing).toBe(CheckCircleFillIcon)
    expect(CHECKS_ICON.failing).toBe(XCircleFillIcon)
    expect(CHECKS_ICON.pending).toBe(DotFillIcon)
  })

  test('a running check shows the dot even when an earlier run left a conclusion', () => {
    expect(checkItemIcon(check({ inFlight: true, conclusion: 'failure' }))).toBe(DotFillIcon)
  })

  test('a skipped check is not drawn as passed', () => {
    expect(checkItemIcon(check({ conclusion: 'skipped' }))).toBe(SkipFillIcon)
  })

  test('a finished check reads as passed or failed by its conclusion', () => {
    expect(checkItemIcon(check({ conclusion: 'success' }))).toBe(CheckCircleFillIcon)
    expect(checkItemIcon(check({ conclusion: 'timed_out' }))).toBe(XCircleFillIcon)
  })
})
