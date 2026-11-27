import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The app manage standards (Paper "Solus — App Manage pages", artboard
// "Standards · app manage"): greys come only from the washes and hairlines,
// one floating surface takes `--elev-lift`, a note, a warning, or an error is
// a callout band (MarkdownAlert), and a state is a mark, never a tint.
// WHY: these sections have no artboard of their own, so nothing else keeps a
// tinted card or a red paragraph from coming back one section at a time.

const MANAGE = join(import.meta.dir, '../../packages/workspace-ui/src/components/app/manage')

const SECTIONS = [
  'OverviewSection.svelte',
  'overview/OverviewAbout.svelte',
  'overview/OverviewAccess.svelte',
  'overview/OverviewDay.svelte',
  'overview/OverviewOperations.svelte',
  'overview/OverviewProblems.svelte',
  'overview/OverviewSource.svelte',
  'overview/OverviewStatus.svelte',
  'WorkflowsSection.svelte',
  'RunDetail.svelte',
  'RunTimeline.svelte',
  'RunFlowCanvas.svelte',
  'RunFlowNode.svelte',
  'StepInspector.svelte',
  'StepCodeSheet.svelte',
  'SessionsSection.svelte',
  'AppSessionCard.svelte',
  'WebhooksSection.svelte',
  'SignalsSection.svelte',
  'SignalActionEditor.svelte',
  'SignalFlowCanvas.svelte',
  'SignalFlowNode.svelte',
  'ConfigSection.svelte',
  'DeploymentSection.svelte',
  'DeploymentPeople.svelte',
  'DeployHistory.svelte',
  'BuildLog.svelte',
  'PickerPill.svelte',
  'FlowZoomControl.svelte',
  'FlowCanvas.svelte',
]

/** Charts: a bar of the run timeline or of the last 24 hours is data, and its colour says what the data is. */
const CHARTS = ['RunTimeline.svelte', 'overview/OverviewDay.svelte']

const markupOf = (file: string) => readFileSync(join(MANAGE, file), 'utf8')

/** Each line of a section that breaks the rule, as "file:line: text". */
function offences(rule: RegExp, files = SECTIONS): string[] {
  return files.flatMap((file) =>
    markupOf(file)
      .split('\n')
      .flatMap((line: string, index: number) => (rule.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
  )
}

describe('the manage sections with no artboard of their own', () => {
  test('no fill or border takes a state colour: a problem is a callout band, not a tinted card', () => {
    const notCharts = SECTIONS.filter((file) => !CHARTS.includes(file))
    expect(offences(/(bg|border)-\[color-mix\([^\]]*--(failure|warning|success|running)/, notCharts)).toEqual([])
    // The hover of a destructive button is not a card.
    expect(offences(/(?<!hover:)bg-destructive\/\d/)).toEqual([])
  })

  test('the greys are the washes and the hairlines, never a literal colour', () => {
    expect(offences(/rgb\(|#[0-9a-fA-F]{3,8}\b/)).toEqual([])
    expect(offences(/\b(bg-muted|border-border)\b/)).toEqual([])
  })

  test('an error is never red text: it is a caution callout', () => {
    // A destructive button (Delete, Unpublish) stays red; text that says what went wrong does not.
    expect(offences(/<(p|span)\b[^>]*(text-destructive|text-\(--failure\))/)).toEqual([])
  })

  test('a state is a mark with its word read aloud, never a coloured word', () => {
    expect(offences(/text-\(--(success|warning)\)/)).toEqual([])
  })
})
