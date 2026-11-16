import { describe, expect, test } from 'bun:test'
import type { AppConfigState } from '@solus/contracts/apps'
import {
  analyzeConfigDocument,
  configCodeMarks,
  configDocumentText,
  configEntryAtLine,
  configRangeText,
  configTypeText,
  replaceConfigValue,
} from '@solus/workspace-ui/components/app/manage/lib/config-document'

const FIELDS: AppConfigState[] = [
  { name: 'digestDay', label: 'Digest day', description: '', type: 'choice', default: 'monday', options: [{ value: 'monday', label: 'Monday' }, { value: 'friday', label: 'Friday' }], value: 'friday', isDefault: false },
  { name: 'lookbackDays', label: 'Days to look back', description: 'How far back the digest reads releases.', type: 'number', default: 7, min: 1, max: 90, integer: true, value: 14, isDefault: false },
  { name: 'includePrereleases', label: 'Include prereleases', description: '', type: 'boolean', default: false, value: false, isDefault: true },
  { name: 'slackChannel', label: 'Slack channel', description: '', type: 'text', default: '#releases', multiline: false, value: '#releases', isDefault: true },
]

const saved = configDocumentText(FIELDS)

function edit(name: string, valueText: string, text = saved): string {
  const change = replaceConfigValue(text, analyzeConfigDocument(text, FIELDS), name, valueText)!
  return text.slice(0, change.from) + change.insert + text.slice(change.to)
}

describe('the Config section’s document', () => {
  test('the saved config reads as one JSON object, a line for each field, and changes nothing', () => {
    // WHY: an editor that opens dirty would save values the owner never touched.
    expect(saved).toBe('{\n  "digestDay": "friday",\n  "lookbackDays": 14,\n  "includePrereleases": false,\n  "slackChannel": "#releases"\n}')
    const analysis = analyzeConfigDocument(saved, FIELDS)
    expect(analysis.problems).toEqual([])
    expect(analysis.changes).toEqual([])
    expect(analysis.entries.map((entry) => [entry.name, entry.line, entry.state])).toEqual([
      ['digestDay', 2, 'saved'],
      ['lookbackDays', 3, 'saved'],
      ['includePrereleases', 4, 'default'],
      ['slackChannel', 5, 'default'],
    ])
    expect(JSON.parse(configDocumentText(FIELDS, 'default'))).toEqual({ digestDay: 'monday', lookbackDays: 7, includePrereleases: false, slackChannel: '#releases' })
  })

  test('Save sends one change for each changed field, and null for a value that is the default again', () => {
    // WHY: appConfigSet takes one field at a time; null is how a field goes back to its default.
    let text = edit('slackChannel', '"#eng-releases"')
    text = edit('lookbackDays', '7', text)
    text = edit('includePrereleases', 'true', text)
    const analysis = analyzeConfigDocument(text, FIELDS)
    expect(analysis.problems).toEqual([])
    expect(analysis.changes.map((change) => [change.field.name, change.value])).toEqual([
      ['lookbackDays', null],
      ['includePrereleases', true],
      ['slackChannel', '#eng-releases'],
    ])
    expect(configEntryAtLine(analysis, 5)?.state).toBe('changed')
  })

  test('a key the owner removes goes back to its default', () => {
    const text = '{\n  "lookbackDays": 14,\n  "includePrereleases": false,\n  "slackChannel": "#releases"\n}'
    expect(analyzeConfigDocument(text, FIELDS).changes.map((change) => [change.field.name, change.value])).toEqual([['digestDay', null]])
  })

  test('an out-of-range number is a problem on its line, with the nearest value as its quick fix', () => {
    // WHY: the host refuses the value; the editor must say so before Save, where the value is.
    const text = edit('lookbackDays', '120')
    const [problem] = analyzeConfigDocument(text, FIELDS).problems
    expect(problem).toMatchObject({ title: 'Out of range.', message: 'lookbackDays takes a whole number from 1 to 90.', line: 3, fix: { label: 'Use 90', text: '90' } })
    expect(text.slice(problem!.from, problem!.to)).toBe('120')
    // The fix makes the document one Save can send.
    const fixed = text.slice(0, problem!.from) + problem!.fix!.text + text.slice(problem!.to)
    expect(analyzeConfigDocument(fixed, FIELDS).changes.map((change) => change.value)).toEqual([90])
  })

  test('each value is checked against its field’s type', () => {
    const problems = (valueText: string, name: string) => analyzeConfigDocument(edit(name, valueText), FIELDS).problems.map((problem) => [problem.title, problem.fix?.text ?? null])
    expect(problems('4.5', 'lookbackDays')).toEqual([['Not a whole number.', '5']])
    expect(problems('"30"', 'lookbackDays')).toEqual([['Wrong type.', '30']])
    expect(problems('"true"', 'includePrereleases')).toEqual([['Wrong type.', 'true']])
    expect(problems('"Friday"', 'digestDay')).toEqual([['Not an option.', '"friday"']])
    expect(problems('"sunday"', 'digestDay')).toEqual([['Not an option.', null]])
    expect(problems('{"a": 1}', 'slackChannel')).toEqual([['Wrong type.', null]])
  })

  test('a key the app does not declare, a key set twice, and text that is not JSON are problems', () => {
    // WHY: Save stays off while there is a problem, so a typo never saves half a config.
    expect(analyzeConfigDocument('{\n  "lookbackDay": 3\n}', FIELDS).problems.map((problem) => [problem.title, problem.line])).toEqual([['Unknown setting.', 2]])
    expect(analyzeConfigDocument('{\n  "lookbackDays": 3,\n  "lookbackDays": 4\n}', FIELDS).problems.map((problem) => [problem.title, problem.line])).toEqual([['Set twice.', 3]])
    const broken = analyzeConfigDocument('{\n  "lookbackDays": 3\n  "slackChannel": "#x"\n}', FIELDS)
    expect(broken.problems.map((problem) => [problem.title, problem.line])).toEqual([['Not valid JSON.', 3]])
    expect(broken.changes).toEqual([])
  })

  test('the inspector names the type and the range of a field', () => {
    expect(configTypeText(FIELDS[1]!)).toBe('Whole number')
    expect(configRangeText(FIELDS[1]!)).toBe('1 to 90')
    expect(configRangeText(FIELDS[0]!)).toBeNull()
  })

  test('Reset to default adds a removed field back before the closing brace', () => {
    const text = '{\n  "lookbackDays": 14\n}'
    const change = replaceConfigValue(text, analyzeConfigDocument(text, FIELDS), 'digestDay', '"monday"')!
    expect(JSON.parse(text.slice(0, change.from) + change.insert + text.slice(change.to))).toEqual({ lookbackDays: 14, digestDay: 'monday' })
  })
})

describe('the marks the code editor draws for the config', () => {
  test('a changed line says what it was, a line at its default says so, and a problem keeps its quick fix', () => {
    // WHY: the shared editor draws only what the section gives it; the "was" hint and the fix must survive the move.
    const text = saved.replace('"lookbackDays": 14', '"lookbackDays": 120').replace('"digestDay": "friday"', '"digestDay": "monday"')
    const marks = configCodeMarks(analyzeConfigDocument(text, FIELDS))
    expect(marks.lines).toContainEqual({ line: 2, isChanged: true, hint: 'was "friday"', isQuietHint: false })
    expect(marks.lines).toContainEqual({ line: 4, isChanged: false, hint: 'default', isQuietHint: true })
    expect(marks.problems).toEqual([expect.objectContaining({ title: 'Out of range.', line: 3, fix: { label: 'Use 90', insert: '90' } })])
  })
})
