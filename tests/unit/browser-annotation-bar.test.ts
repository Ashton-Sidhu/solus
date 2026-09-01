import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * A prop must never be named after a rune.
 *
 * `let { state } = $props()` puts `state` in scope where `$state(x)` is written,
 * so the compiler resolves the rune to the prop and emits a call on it. The
 * component then throws "is not a function" the moment it mounts — with no
 * compile error, no type error, and no test failure, because nothing renders a
 * component in this suite. It cost an interactive run to find; this is cheaper.
 */

const BROWSER = join(import.meta.dir, '../../packages/workspace-ui/src/components/browser')
const COMMENT_COMPOSER = join(
  import.meta.dir,
  '../../packages/workspace-ui/src/components/ui/comment-composer/comment-composer.svelte',
)

/** The rune names that are also plausible prop names. `$props` and `$effect`
 *  are not: nobody names a prop `props`, and one that did would be caught by
 *  the destructuring itself. */
const RUNE_NAMES = ['state', 'derived']

function propBlocks(source: string): string[] {
  // Both shapes the codebase uses: the `interface Props` declaration and the
  // destructuring that reads it.
  const blocks: string[] = []
  const declaration = /interface Props \{([\s\S]*?)\n  \}/.exec(source)
  if (declaration?.[1]) blocks.push(declaration[1])
  const destructure = /let \{([\s\S]*?)\}\s*:\s*[A-Za-z<>"|\s]*Props/.exec(source)
  if (destructure?.[1]) blocks.push(destructure[1])
  return blocks
}

describe('browser component props', () => {
  test('no browser component names a prop after a rune', () => {
    const offenders: string[] = []
    for (const file of readdirSync(BROWSER)) {
      if (!file.endsWith('.svelte')) continue
      const source = readFileSync(join(BROWSER, file), 'utf8')
      // Only a component that actually uses the rune can be shadowed by it.
      const blocks = propBlocks(source)
      for (const rune of RUNE_NAMES) {
        if (!source.includes(`$${rune}(`)) continue
        for (const block of blocks) {
          if (new RegExp(`(^|[{,\\s])${rune}\\s*[,:?}]`).test(block)) {
            offenders.push(`${file}: prop \`${rune}\` shadows the $${rune} rune`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('annotations attach to the active composer without a side rail', () => {
    // WHY: An annotation is a draft attachment. The browser pane must not reserve
    // a second comment surface or flatten the context into the user's editable prompt.
    const pane = readFileSync(join(BROWSER, 'BrowserPane.svelte'), 'utf8')
    expect(pane).toContain('createAnnotationAttachment')
    expect(pane).toContain('input.attachments.push(attachment)')
    expect(pane).not.toContain('BrowserNotesRail')
    expect(pane).not.toContain('notes=')
  })

  test('annotations follow the leading draft instead of an older active tab', () => {
    // WHY: opening a draft does not select a new tab until its first dispatch.
    // The browser sits beside that draft, so using activeTabId silently puts the
    // annotation chip into the last session rather than the visible composer.
    const pane = readFileSync(join(BROWSER, 'BrowserPane.svelte'), 'utf8')
    const workspace = readFileSync(
      join(BROWSER, '../../contexts/workspace/workspace.context.svelte.ts'),
      'utf8',
    )
    const sync = pane.slice(
      pane.indexOf('async function syncAnnotationAttachment'),
      pane.indexOf('async function commitComment'),
    )
    const leadingInput = workspace.slice(
      workspace.indexOf('get leadingInput()'),
      workspace.indexOf('get activeSession()'),
    )

    expect(sync).toContain('session.leadingInput')
    expect(sync).not.toContain('session.activeTabId')
    expect(leadingInput).toContain("ref?.name === 'draft'")
    expect(leadingInput).toContain('return draft.prompt')
    expect(leadingInput).toContain('return this.currentInput')
  })

  test('annotations use a UI-specific default prompt', () => {
    // WHY: a browser mark describes a UI concern, not a generic file upload.
    // The empty composer should tell the agent what action to take.
    const inputBar = readFileSync(
      join(BROWSER, '../input/InputBar.svelte'),
      'utf8',
    )

    expect(inputBar).toContain('attachment.designData?.browserMarks?.length')
    expect(inputBar).toContain('"Please address these UI concerns"')
  })

  test('the annotation pill has no redundant attach action', () => {
    // WHY: committing a commented mark already syncs the structured attachment
    // to the active draft. A second Attach button suggests there is unsaved work.
    const pane = readFileSync(join(BROWSER, 'BrowserPane.svelte'), 'utf8')
    const bar = readFileSync(join(BROWSER, 'BrowserAnnotationBar.svelte'), 'utf8')
    expect(pane).not.toContain('onAttach={() => void attachAnnotations()}')
    expect(bar).not.toContain('onAttach:')
    expect(bar).not.toContain('Paperclip')
    expect(bar).not.toContain('>\n    Attach\n')
  })

  test('a placed mark pops a comment composer that feeds the chip', () => {
    // WHY: after a mark is dropped the user leaves a comment, and that comment
    // must reach the composer attachment — not be lost with the removed rail.
    // A newly-placed mark opens the popup; committing writes the note onto the
    // mark, re-syncs the chip, and then removes the transient page mark.
    const pane = readFileSync(join(BROWSER, 'BrowserPane.svelte'), 'utf8')
    expect(pane).toContain('BrowserCommentPopup')
    expect(pane).toContain('commentingMarkId')
    expect(pane).toContain('kind: "note"')
    expect(pane).toContain('syncAnnotationAttachment')
    expect(pane).toContain('await removePageMark(markId)')
    const commit = pane.slice(
      pane.indexOf('async function commitComment'),
      pane.indexOf('async function removePageMark'),
    )
    expect(commit.indexOf('await syncAnnotationAttachment()')).toBeLessThan(
      commit.lastIndexOf('await removePageMark(markId)'),
    )
  })

  test('saving a comment does not capture the visible browser', () => {
    // WHY: even a passive CDP screenshot asks Electron's webview compositor for
    // a frame. The live trace showed no detach or navigation, but this capture
    // still made the browser flash after every comment. The structured mark is
    // the annotation; screenshots remain an explicit evidence action.
    const pane = readFileSync(join(BROWSER, 'BrowserPane.svelte'), 'utf8')
    const sync = pane.slice(
      pane.indexOf('async function syncAnnotationAttachment'),
      pane.indexOf('async function commitComment'),
    )
    expect(sync).not.toContain('captureEvidence')
    expect(sync).toContain('createAnnotationAttachment')
  })

  test('uncommented marks are discarded instead of reaching the input bar', () => {
    // WHY: a shape without the user's words gives the agent no requested change.
    // Skip, an empty submit, and replacing the open popup must all remove it.
    const pane = readFileSync(join(BROWSER, 'BrowserPane.svelte'), 'utf8')
    expect(pane).toContain('removePageMark')
    expect(pane).toContain('kind: "remove"')
    expect(pane).not.toContain('void syncAnnotationAttachment().catch(() => {});')
  })

  test('leaving annotation mode only disarms the active tool', () => {
    // WHY: every completed or skipped comment removes its own transient mark.
    // A second bulk clear on exit is redundant and can race with a new mark.
    const pane = readFileSync(join(BROWSER, 'BrowserPane.svelte'), 'utf8')
    const leave = pane.slice(
      pane.indexOf('function leaveAnnotationMode'),
      pane.indexOf('function toggleAnnotating'),
    )
    expect(leave).toContain('setAnnotationTool(key, null)')
    expect(leave).not.toContain('kind: "clear"')
  })

  test('the comment popup commits on Enter and dismisses on Escape', () => {
    // WHY: the popup is the only note-entry surface now; a field that could not
    // be submitted or dismissed by keyboard would strand the mark.
    const popup = readFileSync(join(BROWSER, 'BrowserCommentPopup.svelte'), 'utf8')
    const composer = readFileSync(COMMENT_COMPOSER, 'utf8')
    expect(popup).toContain('onCommit')
    expect(popup).toContain('onSkip')
    expect(popup).toContain('surface="compact"')
    expect(composer).toContain('event.key === "Enter"')
    expect(composer).toContain('e.key === "Escape"')
  })

  test('the comment popup morph is interruptible in both directions', () => {
    // WHY: the first character must expand the seed into a card without a height
    // jump, and deleting it must reverse the same motion without remounting the
    // footer or moving focus out of the textarea.
    const popup = readFileSync(join(BROWSER, 'BrowserCommentPopup.svelte'), 'utf8')
    const composer = readFileSync(COMMENT_COMPOSER, 'utf8')
    expect(popup).toContain('surface="compact"')
    expect(composer).toContain("grid-rows-[1fr]")
    expect(composer).toContain("grid-rows-[0fr]")
    expect(composer).toContain('transition-[grid-template-rows]')
    expect(composer).toContain('transition-[opacity,filter,scale]')
    expect(composer).not.toContain('transition:fade')
    expect(composer).not.toContain('{#if hasContent}')
  })

  test('the empty comment seed already has the expanded card shape', () => {
    // WHY: changing from a capsule to a card while the footer expands makes the
    // first keystroke feel like two competing transitions. A stable shell lets
    // only the content and height change under the user's caret.
    const popup = readFileSync(join(BROWSER, 'BrowserCommentPopup.svelte'), 'utf8')
    const shell = popup.slice(popup.indexOf('<div\n  class="comment-pop'), popup.indexOf('>\n  <CommentComposer'))
    expect(shell).toContain('rounded-[14px]')
    expect(shell).not.toContain('rounded-full')
    expect(shell).not.toContain('transition-[border-radius]')
  })
})
