import { StateEffect, StateField, type Range, type Text } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'

/**
 * The marks the shared code editor draws for its owner: a tinted line with
 * the words after it ("was 14", "default"), and a problem in a box under its
 * line with its quick fix. The owner reads its document and gives the marks;
 * the editor only draws them. ⌘. takes the quick fix of the line at the
 * cursor.
 */

/** One way to fix a problem: the text that replaces the span of the problem. */
export interface CodeFix {
  /** The words of the fix, "Use 90". */
  label: string
  insert: string
}

export interface CodeProblem {
  /** The first words, "Out of range." */
  title: string
  /** One sentence: what is wrong, and what the text takes. */
  message: string
  /** The line, from 1, and the span of the document the problem is about. */
  line: number
  from: number
  to: number
  fix: CodeFix | null
}

/** A line the owner marks: tinted when `isChanged`, and with words after it. */
export interface CodeLineMark {
  line: number
  isChanged: boolean
  hint: string | null
  /** A quiet hint, such as "default", is lighter than a change such as "was 14". */
  isQuietHint: boolean
}

export interface CodeMarks {
  problems: readonly CodeProblem[]
  lines: readonly CodeLineMark[]
  /** The line a reader opened the document at: tinted until another line is marked. */
  focusLine: number | null
  applyFix: (problem: CodeProblem, fix: CodeFix) => void
}

export const NO_MARKS: CodeMarks = { problems: [], lines: [], focusLine: null, applyFix: () => {} }

export const setCodeMarks = StateEffect.define<CodeMarks>()

/** The words after a line: "was 14", or "default". */
class HintWidget extends WidgetType {
  constructor(private readonly text: string, private readonly isQuiet: boolean) {
    super()
  }
  override eq(other: HintWidget): boolean {
    return other.text === this.text && other.isQuiet === this.isQuiet
  }
  toDOM(): HTMLElement {
    const hint = document.createElement('span')
    hint.className = this.isQuiet ? 'cm-code-hint cm-code-hint-quiet' : 'cm-code-hint'
    hint.textContent = this.text
    return hint
  }
}

/** The problem box under its line, with its quick fix. */
class ProblemWidget extends WidgetType {
  constructor(private readonly problem: CodeProblem, private readonly applyFix: CodeMarks['applyFix']) {
    super()
  }
  override eq(other: ProblemWidget): boolean {
    return other.problem.title === this.problem.title && other.problem.message === this.problem.message && other.problem.fix?.insert === this.problem.fix?.insert
  }
  toDOM(): HTMLElement {
    const row = document.createElement('div')
    row.className = 'cm-code-problem-row'
    const box = document.createElement('div')
    box.className = 'cm-code-problem'
    box.setAttribute('role', 'alert')
    const title = document.createElement('strong')
    title.textContent = this.problem.title
    const message = document.createElement('span')
    message.textContent = this.problem.message
    box.append(title, message)
    const fix = this.problem.fix
    if (fix) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'cm-code-fix'
      button.textContent = fix.label
      button.title = `${fix.label} · ⌘.`
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', () => this.applyFix(this.problem, fix))
      box.append(button)
    }
    row.append(box)
    return row
  }
  override ignoreEvent(): boolean {
    return true
  }
}

function decorationsFor(doc: Text, { problems, lines, focusLine, applyFix }: CodeMarks): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const problemLines = new Set(problems.map((problem) => problem.line))
  if (focusLine !== null && focusLine >= 1 && focusLine <= doc.lines) ranges.push(Decoration.line({ class: 'cm-code-focus' }).range(doc.line(focusLine).from))
  for (const mark of lines) {
    if (mark.line < 1 || mark.line > doc.lines) continue
    const line = doc.line(mark.line)
    if (mark.isChanged || problemLines.has(mark.line)) ranges.push(Decoration.line({ class: 'cm-code-changed' }).range(line.from))
    // A problem says more than a hint, so a line with a problem has no hint.
    if (mark.hint && !problemLines.has(mark.line)) ranges.push(Decoration.widget({ widget: new HintWidget(mark.hint, mark.isQuietHint), side: 1 }).range(line.to))
  }
  for (const problem of problems) {
    if (problem.line < 1 || problem.line > doc.lines) continue
    const line = doc.line(problem.line)
    if (!lines.some((mark) => mark.line === problem.line)) ranges.push(Decoration.line({ class: 'cm-code-changed' }).range(line.from))
    if (problem.to > problem.from && problem.to <= doc.length) ranges.push(Decoration.mark({ class: 'cm-code-error' }).range(problem.from, problem.to))
    ranges.push(Decoration.widget({ widget: new ProblemWidget(problem, applyFix), block: true, side: 1 }).range(line.to))
  }
  return Decoration.set(ranges, true)
}

export const codeMarksField = StateField.define<{ marks: CodeMarks; decorations: DecorationSet }>({
  create: () => ({ marks: NO_MARKS, decorations: Decoration.none }),
  update(value, transaction) {
    let next = { marks: value.marks, decorations: value.decorations.map(transaction.changes) }
    for (const effect of transaction.effects) {
      if (effect.is(setCodeMarks)) next = { marks: effect.value, decorations: decorationsFor(transaction.state.doc, effect.value) }
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

/** ⌘.: the quick fix of the problem on the cursor's line. */
export function fixAtCursor(view: EditorView): boolean {
  const { marks } = view.state.field(codeMarksField)
  const line = view.state.doc.lineAt(view.state.selection.main.head).number
  const problem = marks.problems.find((candidate) => candidate.line === line && candidate.fix)
  if (!problem?.fix) return false
  marks.applyFix(problem, problem.fix)
  return true
}
