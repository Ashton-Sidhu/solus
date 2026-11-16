import { EditorView } from '@codemirror/view'

/**
 * The look of the shared code editor, from Solus tokens so light and dark
 * both read. CodeMirror owns this DOM, so the tokens are read directly
 * instead of through Tailwind.
 *
 * Two sizes: `document` is a file the reader works in (Config, a source
 * file); `console` is a short input beside other controls (the Insights
 * query, an operation's request).
 */
export type CodeEditorSize = 'document' | 'console'

const MONO = 'var(--solus-font-mono, ui-monospace, monospace)'
const SANS = 'var(--solus-font-sans, ui-sans-serif, sans-serif)'

/** What both sizes share: the panels the editor floats, the marks, and the selection. */
const sharedTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--solus-diff-selection-bg) !important' },
  // Every panel the editor floats — completion, hover docs, diagnostics — is
  // the app's menu surface, composed from the same tokens as `menu-surface`
  // in index.css rather than a second popover language.
  '.cm-tooltip': {
    background: 'var(--solus-menu-bg)',
    border: '0',
    borderRadius: '0.875rem',
    boxShadow: 'var(--solus-menu-shadow)',
    color: 'var(--solus-text-primary)',
    overflow: 'hidden',
    animation: 'var(--animate-menu-pop-in)',
  },
  '@media (prefers-reduced-motion: reduce)': {
    '.cm-tooltip': { animation: 'none' },
  },
  '.cm-tooltip-autocomplete > ul': {
    fontFamily: MONO,
    fontSize: 'var(--text-menu)',
    maxHeight: '16.5rem',
    minWidth: '17rem',
    padding: '0.375rem',
  },
  // A bounded list reveals the standard thumb on hover, as the app's other
  // bounded lists do.
  '.cm-tooltip-autocomplete > ul:hover::-webkit-scrollbar-thumb': {
    background: 'var(--solus-scroll-thumb)',
    backgroundClip: 'padding-box',
  },
  // One row is one line: icon, name, and the detail pushed to the right edge.
  // CodeMirror's own rule sets only `overflow-x: hidden`, so without `nowrap`
  // a long name wraps under its icon.
  '.cm-tooltip-autocomplete > ul > li': {
    alignItems: 'center',
    borderRadius: '0.5rem',
    color: 'var(--solus-text-secondary)',
    display: 'flex',
    gap: '0.5rem',
    height: '2rem',
    lineHeight: '1.25',
    padding: '0 0.375rem',
    transition: 'box-shadow var(--duration-quick) var(--ease-premium), color var(--duration-quick) var(--ease-premium)',
    whiteSpace: 'nowrap',
  },
  // The same ink a menu row uses, laid on as an inset shadow so it washes the
  // row rather than replacing its background.
  '.cm-tooltip-autocomplete > ul > li:hover': {
    boxShadow: 'inset 0 0 0 62rem var(--solus-menu-hover-ink)',
  },
  // The keyboard row takes the accent wash, as the command palette's does.
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'none',
    boxShadow: 'inset 0 0 0 62rem var(--solus-accent-light)',
    color: 'var(--solus-text-primary)',
  },
  '.cm-completionLabel': { flexShrink: '0', overflow: 'hidden', textOverflow: 'ellipsis' },
  // What the reader typed, carried through the name: weight and ink rather
  // than colour, so a long list stays quiet.
  '.cm-completionMatchedText': {
    color: 'var(--solus-text-primary)',
    fontWeight: '600',
    textDecoration: 'none',
  },
  // Sans, because the detail is prose about the row rather than something to
  // be typed — the same split the app's menus use between value and meta.
  '.cm-completionDetail': {
    color: 'var(--solus-text-tertiary)',
    flexShrink: '0',
    fontFamily: SANS,
    fontSize: 'var(--text-menu-meta)',
    fontStyle: 'normal',
    marginLeft: 'auto',
    paddingLeft: '1rem',
  },
  '.cm-completionInfo': {
    borderRadius: '0.875rem',
    color: 'var(--solus-text-secondary)',
    fontFamily: SANS,
    fontSize: 'var(--text-menu)',
    lineHeight: '1.5',
    margin: '0 0.375rem',
    maxWidth: '20rem',
    padding: '0.5rem 0.75rem',
  },
  '.cm-tooltip.cm-tooltip-lint': { padding: '0.125rem' },
  '.cm-diagnostic': {
    borderRadius: '0.625rem',
    fontFamily: SANS,
    fontSize: 'var(--text-menu)',
    lineHeight: '1.5',
    padding: '0.375rem 0.625rem',
  },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--failure)' },
  // The owner's marks (code-marks.ts).
  '.cm-code-focus': { backgroundColor: 'color-mix(in oklch, var(--solus-accent) 9%, transparent)' },
  '.cm-code-changed': { backgroundColor: 'color-mix(in oklch, var(--warning) 7%, transparent)' },
  '.cm-code-hint': { paddingLeft: '1.25rem', fontFamily: SANS, fontSize: '12px', color: 'var(--solus-text-tertiary)' },
  '.cm-code-hint-quiet': { color: 'var(--solus-text-muted)' },
  '.cm-code-error': { textDecoration: 'underline wavy var(--destructive) 1px', textUnderlinePosition: 'under' },
  '.cm-code-problem-row': {
    padding: '0.375rem 1rem 0.5rem 0',
    backgroundColor: 'color-mix(in oklch, var(--warning) 7%, transparent)',
    fontFamily: SANS,
  },
  '.cm-code-problem': {
    display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.25rem 0.625rem',
    padding: '0.5rem 0.75rem', borderRadius: '10px', fontSize: '13px', lineHeight: '1.125rem',
    backgroundColor: 'color-mix(in oklch, var(--destructive) 8%, transparent)', color: 'var(--destructive)',
  },
  '.cm-code-problem strong': { fontWeight: '600' },
  '.cm-code-fix': {
    border: '0', background: 'none', padding: '0', cursor: 'pointer', font: 'inherit', color: 'inherit',
    textDecoration: 'underline', textUnderlineOffset: '3px',
  },
  '.cm-code-fix:focus-visible': { outline: '2px solid var(--ring)', outlineOffset: '2px', borderRadius: '4px' },
})

const documentTheme = EditorView.theme({
  '&': { fontSize: '13.5px' },
  '.cm-scroller': { fontFamily: MONO, lineHeight: '1.75rem', overflow: 'auto' },
  '.cm-content': { padding: '0.875rem 0 1.125rem', caretColor: 'var(--foreground)' },
  '.cm-line': { padding: '0 1rem 0 0' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--solus-text-muted)' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '3.5rem', padding: '0 1.25rem 0 0', fontSize: '12px', textAlign: 'right' },
})

const consoleTheme = EditorView.theme({
  '&': { fontSize: '0.8125rem' },
  '.cm-content': { padding: '0', fontFamily: MONO },
  '.cm-line': { padding: '0 0 0 0.5rem', lineHeight: '1.5rem' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--muted-foreground)',
    opacity: '0.5',
  },
  '.cm-lineNumbers .cm-gutterElement': { lineHeight: '1.5rem', minWidth: '1.25rem' },
  '.cm-scroller': { fontFamily: 'inherit', overflow: 'auto' },
})

export function codeEditorTheme(size: CodeEditorSize) {
  return [sharedTheme, size === 'document' ? documentTheme : consoleTheme]
}
