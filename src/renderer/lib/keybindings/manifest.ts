import type { BindingDef } from './types'
import { defaultCombo, formatCombo } from './match'

export const KEYBINDINGS = {
  // ── Global ─────────────────────────────────────────────────────────────────
  'global.open-host-project': { combo: { mod: true, code: 'KeyO' }, web: { alt: true, code: 'KeyO' }, scope: 'global', label: 'Open project on current host', group: 'General' },
  'global.select-project':    { combo: { mod: true, shift: true, code: 'KeyO' },        scope: 'global',             label: 'Open project',             group: 'General' },
  'global.new-task':          { combo: { mod: true, code: 'KeyN' }, web: { alt: true, shift: true, code: 'KeyN' }, scope: 'global', label: 'New task',                 group: 'Tasks' },
  'global.new-session-without-task': { combo: { mod: true, shift: true, code: 'KeyN' }, scope: 'global', label: 'New session without task', group: 'Tasks' },
  'global.new-session':       { combo: { mod: true, code: 'KeyT' }, web: { alt: true, shift: true, code: 'KeyT' }, scope: 'global', label: 'New session in task',       group: 'Tasks' },
  'global.new-split-chat':    { combo: { alt: true, shift: true, code: 'Slash' },          scope: 'global',             label: 'Toggle split chat',        group: 'Tabs' },
  'global.fork-tab':          { combo: { alt: true, code: 'KeyF' },                       scope: 'global',             label: 'Fork session',             group: 'Tabs' },
  'global.next-tab':          { combo: { ctrl: true, code: 'Tab' }, web: { alt: true, shift: true, code: 'ArrowRight' }, scope: 'global', label: 'Next branch / tab',     group: 'Tabs' },
  'global.prev-tab':          { combo: { ctrl: true, shift: true, code: 'Tab' }, web: { alt: true, shift: true, code: 'ArrowLeft' }, scope: 'global', label: 'Previous branch / tab', group: 'Tabs' },
  'global.next-session':      { combo: { alt: true, shift: true, code: 'KeyN' },          scope: 'global',             label: 'Next session in branch',   group: 'Tabs' },
  'global.prev-session':      { combo: { alt: true, shift: true, code: 'KeyP' },          scope: 'global',             label: 'Previous session in branch', group: 'Tabs' },
  'global.close-tab':         { combo: { mod: true, shift: true, code: 'KeyW' }, web: { alt: true, shift: true, code: 'KeyW' }, scope: 'global', label: 'Close tab',          group: 'Tabs' },
  'global.group-tabs':         { combo: { alt: true, shift: true, code: 'KeyU' },          scope: 'global',             label: 'Group tabs by status',     group: 'Tabs' },
  'global.screenshot':        { combo: { alt: true, shift: true, code: 'KeyS' },          scope: 'global',             label: 'Take screenshot',          group: 'Compose' },
  'global.attach-file':       { combo: { alt: true, shift: true, code: 'KeyA' },          scope: 'global',             label: 'Attach file',              group: 'Compose' },
  'global.design-mode':       { combo: { alt: true, shift: true, code: 'KeyI' },          scope: 'global',             label: 'Design mode',              group: 'Compose' },
  'global.save-prompt':       { combo: { mod: true, shift: true, code: 'KeyS' },          scope: 'global',             label: 'Save prompt',              group: 'Compose' },
  'global.saved-prompts':     { combo: { alt: true, shift: true, code: 'KeyK' },          scope: 'global',             label: 'Saved prompts',            group: 'Compose' },
  'global.continue-in-mode':  { combo: { alt: true, shift: true, code: 'KeyE' },          scope: 'global',             label: 'Continue in editor / pill', group: 'View' },
  'global.toggle-diff-panel':    { combo: { alt: true, shift: true, code: 'KeyD' },        scope: 'global',             label: 'Toggle diff panel',        group: 'View' },
  'global.toggle-files':         { combo: { alt: true, shift: true, code: 'KeyO' },        scope: 'global',             label: 'Open files',               group: 'View' },
  'global.open-in-split': { combo: { alt: true, shift: true, code: 'Backslash' }, scope: 'global',             label: 'Open artifact in split',   group: 'View' },
  'global.toggle-project-panel': { combo: { alt: true, code: 'KeyM' },                   scope: 'global',             label: 'Toggle project panel',     group: 'View' },
  'global.toggle-workspace':     { combo: { alt: true, shift: true, code: 'KeyL' },       scope: 'global',             label: 'Open workspace',           group: 'View' },
  'global.toggle-automations': { combo: { alt: true, shift: true, code: 'KeyV' },          scope: 'global',             label: 'Open automations',         group: 'View' },
  'global.toggle-tasks':       { combo: { alt: true, shift: true, code: 'KeyT' },          scope: 'global',             label: 'Open tasks',               group: 'View' },
  'global.toggle-insights':    { combo: { alt: true, shift: true, code: 'KeyI' },          scope: 'global',             label: 'Open insights',            group: 'View' },
  'global.toggle-sidebar':     { combo: { mod: true, code: 'KeyB' },                       scope: 'global',             label: 'Toggle sidebar',           group: 'View' },
  'global.toggle-expanded':   { combo: { alt: true, shift: true, code: 'Equal' },         scope: 'global',             label: 'Expand / collapse input',  group: 'View' },
  // Desktop-only: on web these combos stay with the browser's own zoom (the
  // handlers register disabled there, so the dispatcher lets them fall through).
  'global.zoom-in':           { combo: { mod: true, code: 'Equal' },                      scope: 'global',             label: 'Zoom in',                  group: 'View' },
  'global.zoom-out':          { combo: { mod: true, code: 'Minus' },                      scope: 'global',             label: 'Zoom out',                 group: 'View' },
  'global.zoom-reset':        { combo: { mod: true, code: 'Digit0' },                     scope: 'global',             label: 'Reset zoom',               group: 'View' },
  'global.history-back':      { combo: { mod: true, code: 'BracketLeft' },              scope: 'global',             label: 'Back',                     group: 'Navigation' },
  'global.history-forward':   { combo: { mod: true, code: 'BracketRight' },             scope: 'global',             label: 'Forward',                  group: 'Navigation' },
  'global.session-picker':    { combo: { mod: true, code: 'KeyP' }, web: { alt: true, shift: true, code: 'KeyR' }, scope: 'global', label: 'Session picker',           group: 'Navigation' },
  'global.session-picker-j': { combo: { alt: true, shift: true, code: 'KeyJ' },          scope: 'global',             label: 'Session picker (alt)',     group: 'Navigation' },
  'global.task-picker':       { combo: { alt: true, shift: true, code: 'KeyF' },          scope: 'global',             label: 'Task picker',              group: 'Navigation' },
  'global.focus-sidebar-task-search': { combo: { ctrl: true, code: 'Slash' },             scope: 'global',             label: 'Focus sidebar task search', group: 'Tasks' },
  'global.cycle-perm-mode':   { combo: { alt: true, shift: true, code: 'Tab' },           scope: 'global',             label: 'Cycle permission mode',    group: 'Agent' },
  'global.cycle-model':       { combo: { alt: true, shift: true, code: 'KeyM' },          scope: 'global',             label: 'Cycle model',              group: 'Agent' },
  'global.cycle-agent':       { combo: { alt: true, shift: true, code: 'KeyG' },          scope: 'global',             label: 'Cycle agent',              group: 'Agent' },
  'global.toggle-reasoning':  { combo: { alt: true, shift: true, code: 'KeyZ' },          scope: 'global',             label: 'Open model menu',          group: 'Agent' },
  'global.run-picker':        { combo: { alt: true, shift: true, code: 'Comma' },         scope: 'global',             label: 'Open run picker',          group: 'Agent' },
  'global.settings':          { combo: { mod: true, code: 'Comma' },                      scope: 'global',             label: 'Settings',                 group: 'General' },
  'global.focus-input':       { combo: { mod: true, code: 'KeyL' }, web: { alt: true, code: 'KeyL' }, scope: 'global',  label: 'Focus input',              group: 'General' },
  'global.toggle-worktree':   { combo: { alt: true, shift: true, code: 'KeyB' },          scope: 'global',             label: 'Toggle worktree mode',     group: 'Git' },
  'global.switch-worktree':   { combo: { alt: true, shift: true, code: 'KeyH' },          scope: 'global',             label: 'Switch worktree',          group: 'Git' },
  'global.continue-worktree': { combo: { alt: true, code: 'KeyW' },                       scope: 'global',             label: 'Continue in worktree',     group: 'Git' },
  'global.git-open-terminal': { combo: { alt: true, shift: true, code: 'KeyY' },          scope: 'global',             label: 'Open worktree in terminal', group: 'Git' },
  'global.show-shortcuts':    { combo: { mod: true, code: 'Slash' },                      scope: 'global',             label: 'Keyboard shortcuts',       group: 'General' },
  'global.command-palette':   { combo: { mod: true, code: 'KeyK' },                       scope: 'global',             label: 'Command palette',          group: 'General' },
  'global.project-search':    { combo: { mod: true, shift: true, code: 'KeyF' },           scope: 'global',             label: 'Search in project',        group: 'Navigation' },
  'global.go-to-file':        { combo: { mod: true, code: 'KeyE' },                        scope: 'global',             label: 'Go to file',               group: 'Navigation' },

  // ── Voice (global, gated by viewMode + not read-only) ──────────────────────
  'voice.toggle-mode':        { combo: { alt: true, shift: true, code: 'KeyV' },          scope: 'global',             label: 'Toggle voice mode',        group: 'Voice' },
  'voice.toggle-recorder':    { combo: { alt: true, shift: true, code: 'Space' },         scope: 'global',             label: 'Start / finish voice recording', group: 'Voice' },

  // ── Action orb (global, gated by active tab) ───────────────────────────────
  'orb.toggle':               { combo: { alt: true, shift: true, code: 'KeyQ' },          scope: 'global',             label: 'Toggle quick actions',     group: 'General' },
  'orb.open-terminal':        { combo: { alt: true, shift: true, code: 'Backquote' },     scope: 'global',             label: 'Open terminal',            group: 'General' },
  'orb.commit-push':          { combo: { alt: true, shift: true, code: 'KeyC' },          scope: 'global',             label: 'Commit and push',          group: 'General' },
  'orb.sync':                 { combo: { alt: true, shift: true, code: 'Period' },        scope: 'global',             label: 'Sync (pull)',              group: 'General' },
  'orb.pin':                  { combo: { alt: true, shift: true, code: 'KeyX' },          scope: 'global',             label: 'Pin / unpin session',      group: 'General' },

  // ── Conversation (global, gated by active tab) ─────────────────────────────
  'conversation.scroll-top':      { combo: { alt: true, code: 'KeyH' },                   scope: 'global',             label: 'Scroll to first message',  group: 'Conversation' },
  'conversation.scroll-bottom':   { combo: { alt: true, code: 'KeyE' },                   scope: 'global',             label: 'Scroll to bottom',         group: 'Conversation' },
  'conversation.find':            { combo: { mod: true, code: 'KeyF' },                   scope: 'global',             label: 'Find in conversation',     group: 'Conversation' },
  'conversation.close-find':      { combo: { code: 'Escape' },                            scope: 'global',             label: 'Close conversation find',  group: 'Conversation' },
  'conversation.open-files':      { combo: { alt: true, shift: true, code: 'KeyF' },      scope: 'global',             label: 'Open changed files',       group: 'Conversation' },
  'conversation.interrupt':       { combo: { ctrl: true, code: 'KeyC' },                  scope: 'global',             label: 'Stop agent',               group: 'Conversation' },

  // ── Diff panel ─────────────────────────────────────────────────────────────
  'diff-panel.close':             { combo: { code: 'Escape' },                             scope: 'diff-panel',         label: 'Close panel',              group: 'Panel' },
  'diff-panel.maximize':          { combo: { alt: true, code: 'KeyM' },                    scope: 'diff-panel',         label: 'Maximize / restore',       group: 'Panel' },
  'diff-panel.refresh':           { combo: { alt: true, code: 'KeyR' },                    scope: 'diff-panel',         label: 'Refresh diff',             group: 'Panel' },
  'diff-panel.next-file':         { combo: { alt: true, code: 'KeyN' },                    scope: 'diff-panel',         label: 'Next file',                group: 'Navigate' },
  'diff-panel.prev-file':         { combo: { alt: true, code: 'KeyP' },                    scope: 'diff-panel',         label: 'Previous file',            group: 'Navigate' },
  'diff-panel.find':              { combo: { mod: true, code: 'KeyF' }, aliases: [{ alt: true, code: 'KeyF' }], scope: 'diff-panel', label: 'Find in diff',     group: 'Navigate' },
  'diff-panel.toggle-tree':       { combo: { alt: true, code: 'KeyT' },                    scope: 'diff-panel',         label: 'Toggle file tree',         group: 'Navigate' },
  'diff-panel.next-comment':      { combo: { alt: true, code: 'BracketRight' },           scope: 'diff-panel',         label: 'Next comment',             group: 'Navigate' },
  'diff-panel.prev-comment':      { combo: { alt: true, code: 'BracketLeft' },            scope: 'diff-panel',         label: 'Previous comment',         group: 'Navigate' },
  'diff-panel.next-turn':         { combo: { alt: true, code: 'ArrowRight' },             scope: 'diff-panel',         label: 'Next turn',                group: 'Navigate' },
  'diff-panel.prev-turn':         { combo: { alt: true, code: 'ArrowLeft' },              scope: 'diff-panel',         label: 'Previous turn',            group: 'Navigate' },
  'diff-panel.toggle-view':       { combo: { alt: true, code: 'KeyV' },                    scope: 'diff-panel',         label: 'Toggle split / unified',   group: 'Navigate' },
  'diff-panel.toggle-token-hl':   { combo: { alt: true, code: 'KeyH' },                    scope: 'diff-panel',         label: 'Toggle token highlighting', group: 'Navigate' },
  'diff-panel.start-comment':     { combo: { alt: true, code: 'KeyC' },                    scope: 'diff-panel',         label: 'Start comment',            group: 'Comment & send' },
  'diff-panel.submit':            { combo: { alt: true, code: 'Enter' },                   scope: 'diff-panel',         label: 'Send to session',          group: 'Comment & send' },

  // ── File editor ────────────────────────────────────────────────────────────
  'file-editor.close':            { combo: { code: 'Escape' },                             scope: 'file-editor',        label: 'Close file',               group: 'Editor' },
  'file-editor.save':             { combo: { alt: true, code: 'KeyS' },                    scope: 'file-editor',        label: 'Save file',                group: 'Editor' },
  'file-editor.toggle-markdown':  { combo: { alt: true, code: 'KeyM' },                    scope: 'file-editor',        label: 'Toggle Markdown view',     group: 'Editor' },

  // ── Files pane ─────────────────────────────────────────────────────────────
  'files-pane.close':             { combo: { code: 'Escape' },                             scope: 'files-pane',         label: 'Close files',              group: 'Panel' },
  // Unassigned: every ⌥ letter this pane could use is already spoken for here
  // (⌥M toggles the Markdown view), so the action ships bindable but silent.
  'files-pane.maximize':          { combo: null,                                           scope: 'files-pane',         label: 'Maximize / restore',       group: 'Panel' },
  'files-pane.toggle-tree':       { combo: { alt: true, code: 'KeyT' },                    scope: 'files-pane',         label: 'Toggle file tree',         group: 'Navigate' },
  'files-pane.focus-search':      { combo: { code: 'Slash' },                              scope: 'files-pane',         label: 'Focus search',             group: 'Navigate' },
  'files-pane.next-file':         { combo: { alt: true, code: 'KeyJ' },                    scope: 'files-pane',         label: 'Next file',                group: 'Navigate' },
  'files-pane.prev-file':         { combo: { alt: true, code: 'KeyK' },                    scope: 'files-pane',         label: 'Previous file',            group: 'Navigate' },
  'files-pane.toggle-markdown':   { combo: { alt: true, code: 'KeyM' },                    scope: 'files-pane',         label: 'Toggle Markdown view',     group: 'Editor' },

  // ── Workspace (plans + docs + diagrams ledger) ─────────────────────────────
  'workspace.close':              { combo: { code: 'Escape' },                             scope: 'workspace',          label: 'Close',                    group: 'Workspace' },
  'workspace.focus-search':       { combo: { code: 'Slash' },                              scope: 'workspace',          label: 'Focus search',             group: 'Workspace' },
  'workspace.open':               { combo: { code: 'Enter' },                              scope: 'workspace',          label: 'Open item',                group: 'Workspace' },
  'workspace.resume':             { combo: { shift: true, code: 'Enter' },                 scope: 'workspace',          label: 'Resume session',           group: 'Workspace' },
  'workspace.next':               { combo: { code: 'ArrowDown' }, repeatable: true,        scope: 'workspace',          label: 'Next',                     group: 'Navigate' },
  'workspace.prev':               { combo: { code: 'ArrowUp' }, repeatable: true,          scope: 'workspace',          label: 'Previous',                 group: 'Navigate' },
  'workspace.toggle-pin':         { combo: { alt: true, code: 'KeyP' },                    scope: 'workspace',          label: 'Pin / unpin',              group: 'Workspace' },
  // The peek is a pointer affordance, so the keyboard gets its own: the same
  // card, pinned, on the focused row. No hover state is ever required to reach
  // information.
  'workspace.peek':               { combo: { code: 'Space' },                              scope: 'workspace',          label: 'Peek',                     group: 'Workspace' },

  // ── Plan review ────────────────────────────────────────────────────────────
  'plan-review.approve-ask':      { combo: { alt: true, code: 'KeyY' },                    scope: 'plan-action-bar',    label: 'Approve (ask mode)',       group: 'Review' },
  'plan-review.approve-auto':     { combo: { alt: true, code: 'KeyA' },                    scope: 'plan-action-bar',    label: 'Approve (auto mode)',      group: 'Review' },
  'plan-review.reject':           { combo: { alt: true, code: 'KeyR' },                    scope: 'plan-action-bar',    label: 'Reject',                   group: 'Review' },
  'plan-review.reject-revise':    { combo: { alt: true, code: 'KeyV' },                    scope: 'plan-action-bar',    label: 'Reject with feedback',     group: 'Review' },
  'plan-review.focus-comment':    { combo: { alt: true, code: 'KeyL' },                    scope: 'plan-action-bar',    label: 'Focus comment field',      group: 'Review' },
  'plan-review.toggle-worktree':  { combo: { alt: true, code: 'KeyW' },                    scope: 'plan-action-bar',    label: 'Toggle worktree',          group: 'Review' },
  'plan-review.toggle-collapsed': { combo: { alt: true, code: 'KeyD' },                    scope: 'plan-action-bar',    label: 'Collapse / expand bar',    group: 'Review' },

  // ── Plan modal ─────────────────────────────────────────────────────────────
  'plan-modal.close':             { combo: { code: 'Escape' },                             scope: 'plan-modal',         label: 'Close',                    group: 'Modal' },
  'plan-modal.start-comment':     { combo: { mod: true, code: 'KeyM' },                    scope: 'plan-modal',         label: 'Comment on selection',     group: 'Modal' },
  'plan-modal.save':              { combo: { alt: true, code: 'KeyS' },                    scope: 'plan-modal',         label: 'Save',                     group: 'Modal' },
  'plan-modal.copy':              { combo: { alt: true, code: 'KeyC' },                    scope: 'plan-modal',         label: 'Copy to clipboard',        group: 'Modal' },
  'plan-modal.toggle-bookmark':   { combo: { alt: true, code: 'KeyB' },                    scope: 'plan-modal',         label: 'Toggle bookmark',          group: 'Modal' },
  'plan-modal.toggle-comments':   { combo: { alt: true, code: 'KeyM' },                    scope: 'plan-modal',         label: 'Toggle comments',          group: 'Modal' },
  'plan-modal.resume':            { combo: { alt: true, code: 'KeyO' },                    scope: 'plan-modal',         label: 'Resume session',           group: 'Modal' },
  'plan-modal.find':              { combo: { mod: true, code: 'KeyF' },                    scope: 'plan-modal',         label: 'Find & replace',           group: 'Modal' },
  'plan-modal.pin-outline':       { combo: { mod: true, alt: true, code: 'Backslash' },    scope: 'plan-modal',         label: 'Pin table of contents',    group: 'Modal' },
  'plan-modal.new-tab':           { combo: { mod: true, code: 'KeyT' }, web: { alt: true, shift: true, code: 'KeyT' }, scope: 'plan-modal', label: 'New tab',         group: 'Modal' },

  // ── Document modal ─────────────────────────────────────────────────────────
  'document-modal.close':         { combo: { code: 'Escape' },                             scope: 'document-modal',     label: 'Close',                    group: 'Modal' },
  'document-modal.start-comment': { combo: { mod: true, code: 'KeyM' },                    scope: 'document-modal',     label: 'Comment on selection',     group: 'Modal' },
  'document-modal.save':          { combo: { alt: true, code: 'KeyS' },                    scope: 'document-modal',     label: 'Save',                     group: 'Modal' },
  'document-modal.copy':          { combo: { alt: true, code: 'KeyC' },                    scope: 'document-modal',     label: 'Copy to clipboard',        group: 'Modal' },
  'document-modal.find':          { combo: { mod: true, code: 'KeyF' },                    scope: 'document-modal',     label: 'Find & replace',           group: 'Modal' },
  'document-modal.pin-outline':   { combo: { mod: true, alt: true, code: 'Backslash' },    scope: 'document-modal',     label: 'Pin table of contents',    group: 'Modal' },
  'document-modal.google-upload': { combo: { alt: true, code: 'KeyG' },                    scope: 'document-modal',     label: 'Open in Google Docs',      group: 'Modal' },
  'plan-modal.google-upload':     { combo: { alt: true, code: 'KeyG' },                    scope: 'plan-modal',         label: 'Open in Google Docs',      group: 'Modal' },

  // ── Automations ────────────────────────────────────────────────────────────
  'automations.close':            { combo: { code: 'Escape' },                             scope: 'automations',        label: 'Close',                    group: 'Automations' },
  'automations.new':              { combo: { alt: true, code: 'KeyN' },                    scope: 'automations',        label: 'New automation',           group: 'Automations' },

  // ── Insights ───────────────────────────────────────────────────────────────
  'insights.close':               { combo: { code: 'Escape' },                             scope: 'insights',           label: 'Close',                    group: 'Insights' },
  'insights.natural-language':    { combo: { alt: true, code: 'Digit1' },                  scope: 'insights',           label: 'Ask in natural language',  group: 'Insights' },
  'insights.sql':                 { combo: { alt: true, code: 'Digit2' },                  scope: 'insights',           label: 'Write SQL',                group: 'Insights' },
  'insights.refresh':             { combo: { alt: true, code: 'KeyR' },                    scope: 'insights',           label: 'Refresh the window',       group: 'Insights' },

  // ── Tasks ───────────────────────────────────────────────────────────────────
  'tasks.close':                  { combo: { code: 'Escape' },                             scope: 'tasks',              label: 'Close',                    group: 'Tasks' },

  // ── Pull Requests ──────────────────────────────────────────────────────────
  'prs.close':                    { combo: { code: 'Escape' },                             scope: 'prs',                label: 'Close',                    group: 'Pull Requests' },

  // ── PR review ──────────────────────────────────────────────────────────────
  'pr-review.approve':            { combo: { alt: true, code: 'KeyA' },                    scope: 'pr-review',          label: 'Approve pull request',     group: 'Pull Requests' },

  // ── Design annotation ──────────────────────────────────────────────────────
  'annotation.cancel':            { combo: { code: 'Escape' },                             scope: 'design-annotation',  label: 'Cancel / dismiss',         group: 'Annotation' },
  'annotation.confirm':           { combo: { mod: true, code: 'Enter' },                   scope: 'design-annotation',  label: 'Confirm',                  group: 'Annotation' },
  'annotation.undo':              { combo: { mod: true, code: 'KeyZ' },                    scope: 'design-annotation',  label: 'Undo',                     group: 'Annotation' },
  'annotation.redo':              { combo: { mod: true, shift: true, code: 'KeyZ' },       scope: 'design-annotation',  label: 'Redo',                     group: 'Annotation' },
  'annotation.tool-rect':         { combo: { code: 'Digit1' },                             scope: 'design-annotation',  label: 'Rectangle tool',           group: 'Tools' },
  'annotation.tool-arrow':        { combo: { code: 'Digit2' },                             scope: 'design-annotation',  label: 'Arrow tool',               group: 'Tools' },
  'annotation.tool-pin':          { combo: { code: 'Digit3' },                             scope: 'design-annotation',  label: 'Pin tool',                 group: 'Tools' },
  'annotation.tool-text':         { combo: { code: 'Digit4' },                             scope: 'design-annotation',  label: 'Text tool',                group: 'Tools' },
  'annotation.tool-eraser':       { combo: { code: 'Digit5' },                             scope: 'design-annotation',  label: 'Eraser tool',              group: 'Tools' },

  // ── Diagram ────────────────────────────────────────────────────────────────
  // Bare keys (Delete/Arrows) and ⌘ combos are intentional canvas
  // conventions (Figma/Miro), gated to fire only when the canvas is focused.
  'diagram.undo':                 { combo: { mod: true, code: 'KeyZ' },                     scope: 'diagram',            label: 'Undo',                     group: 'Edit' },
  'diagram.redo':                 { combo: { mod: true, shift: true, code: 'KeyZ' },        scope: 'diagram',            label: 'Redo',                     group: 'Edit' },
  'diagram.select-all':           { combo: { mod: true, code: 'KeyA' },                     scope: 'diagram',            label: 'Select all',               group: 'Edit' },
  'diagram.copy':                 { combo: { mod: true, code: 'KeyC' },                     scope: 'diagram',            label: 'Copy selection',           group: 'Edit' },
  'diagram.paste':                { combo: { mod: true, code: 'KeyV' },                     scope: 'diagram',            label: 'Paste',                    group: 'Edit' },
  'diagram.duplicate':            { combo: { mod: true, code: 'KeyD' },                     scope: 'diagram',            label: 'Duplicate selection',      group: 'Edit' },
  'diagram.delete-forward':       { combo: { code: 'Delete' }, aliases: [{ code: 'Backspace' }], scope: 'diagram',            label: 'Delete selection',         group: 'Edit' },
  'diagram.add-node':             { combo: { alt: true, code: 'KeyN' },                     scope: 'diagram',            label: 'Add node',                 group: 'Canvas' },
  'diagram.add-group':            { combo: { alt: true, code: 'KeyG' },                     scope: 'diagram',            label: 'Add group',                group: 'Canvas' },
  'diagram.send-to-back':         { combo: { mod: true, shift: true, code: 'BracketLeft' }, scope: 'diagram',            label: 'Send to back',             group: 'Canvas' },
  'diagram.bring-to-front':       { combo: { mod: true, shift: true, code: 'BracketRight' }, scope: 'diagram',           label: 'Bring to front',           group: 'Canvas' },
  'diagram.search':               { combo: { mod: true, code: 'KeyF' },                     scope: 'diagram',            label: 'Search nodes',             group: 'Canvas' },
  'diagram.comments':             { combo: { alt: true, code: 'KeyC' },                     scope: 'diagram',            label: 'Toggle comments',          group: 'Canvas' },
  'diagram.toggle-inspector':     { combo: { mod: true, code: 'Backslash' },                scope: 'diagram',            label: 'Toggle inspector',         group: 'Canvas' },
  'diagram.dismiss':              { combo: { code: 'Escape' },                              scope: 'diagram',            label: 'Close search / drawer / focus', group: 'Canvas' },
  'diagram.zoom-in':              { combo: { code: 'PageUp' },                              scope: 'diagram',            label: 'Zoom in',                  group: 'Canvas' },
  'diagram.zoom-out':             { combo: { code: 'PageDown' },                            scope: 'diagram',            label: 'Zoom out',                 group: 'Canvas' },
  'diagram.nudge-up':             { combo: { code: 'ArrowUp' },                             scope: 'diagram',            label: 'Nudge up',                 group: 'Move' },
  'diagram.nudge-down':           { combo: { code: 'ArrowDown' },                           scope: 'diagram',            label: 'Nudge down',               group: 'Move' },
  'diagram.nudge-left':           { combo: { code: 'ArrowLeft' },                           scope: 'diagram',            label: 'Nudge left',               group: 'Move' },
  'diagram.nudge-right':          { combo: { code: 'ArrowRight' },                          scope: 'diagram',            label: 'Nudge right',              group: 'Move' },
  'diagram.nudge-up-fine':        { combo: { shift: true, code: 'ArrowUp' },                scope: 'diagram',            label: 'Nudge up (1px)',           group: 'Move' },
  'diagram.nudge-down-fine':      { combo: { shift: true, code: 'ArrowDown' },              scope: 'diagram',            label: 'Nudge down (1px)',         group: 'Move' },
  'diagram.nudge-left-fine':      { combo: { shift: true, code: 'ArrowLeft' },              scope: 'diagram',            label: 'Nudge left (1px)',         group: 'Move' },
  'diagram.nudge-right-fine':     { combo: { shift: true, code: 'ArrowRight' },             scope: 'diagram',            label: 'Nudge right (1px)',        group: 'Move' },

  // ── Attachment preview ─────────────────────────────────────────────────────
  'attachment.close-preview':     { combo: { code: 'Escape' },                             scope: 'attachment-preview', label: 'Close preview',            group: 'General' },

  // ── Saved prompts (sheet open; ⌫ is gated on an empty search field so it
  //    still backspaces while you type) ───────────────────────────────────────
  'saved-prompts.delete':         { combo: { code: 'Backspace' },                          scope: 'saved-prompts',      label: 'Delete saved prompt',      group: 'Saved prompts' },

  // ── Command palette ────────────────────────────────────────────────────────
  'command-palette.close':        { combo: { code: 'Escape' },                             scope: 'command-palette',    label: 'Close',                    group: 'Palette' },

  // ── Project search ─────────────────────────────────────────────────────────
  'go-to-file.close':             { combo: { code: 'Escape' },                             scope: 'go-to-file',         label: 'Close',                    group: 'Search' },
  'project-search.close':         { combo: { code: 'Escape' },                             scope: 'project-search',     label: 'Close',                    group: 'Search' },
  'project-search.match-case':    { combo: { alt: true, code: 'KeyC' },                    scope: 'project-search',     label: 'Match case',               group: 'Search' },
  'project-search.whole-word':    { combo: { alt: true, code: 'KeyW' },                    scope: 'project-search',     label: 'Match whole word',         group: 'Search' },
  'project-search.regex':         { combo: { alt: true, code: 'KeyR' },                    scope: 'project-search',     label: 'Use regular expression',   group: 'Search' },

  // ── Shortcuts help modal ───────────────────────────────────────────────────
  'shortcuts-help.close':         { combo: { code: 'Escape' },                             scope: 'shortcuts-help',     label: 'Close',                    group: 'Modal' },

  // ── Unassigned by default ──────────────────────────────────────────────────
  // Menus and pages that are only reachable by pointer or through the command
  // palette. They ship with no combo so they claim no key from anyone, and are
  // listed in Settings → Keybindings for a user who reaches for one often
  // enough to want a key of their own. They join the sections above by `group`,
  // so declaration here keeps them out of the way without moving them in the UI.
  'global.switch-branch':         { combo: null,                                           scope: 'global',             label: 'Switch branch',            group: 'Git' },
  'global.new-session-worktree':  { combo: null,                                           scope: 'global',             label: 'New session in new worktree', group: 'Git' },
  'global.new-session-in':        { combo: null,                                           scope: 'global',             label: 'New session in branch or worktree…', group: 'Git' },
  'global.working-tree-diff':     { combo: null,                                           scope: 'global',             label: 'View working tree diff',   group: 'Git' },
  'global.open-prs':              { combo: null,                                           scope: 'global',             label: 'Open pull requests',       group: 'Pull Requests' },
  'global.review-pr':             { combo: null,                                           scope: 'global',             label: 'Review pull request…',     group: 'Pull Requests' },
  'global.open-plan':             { combo: null,                                           scope: 'global',             label: 'Open plan…',               group: 'Navigation' },
  'global.open-document':         { combo: null,                                           scope: 'global',             label: 'Open document…',           group: 'Navigation' },
  'global.open-automation':       { combo: null,                                           scope: 'global',             label: 'Open automation…',         group: 'Navigation' },
  'global.open-task':             { combo: null,                                           scope: 'global',             label: 'Open task…',               group: 'Navigation' },
  'global.create-task-in':        { combo: null,                                           scope: 'global',             label: 'Create task in project…',  group: 'Tasks' },
  'global.permission-menu':       { combo: null,                                           scope: 'global',             label: 'Open permission mode menu', group: 'Agent' },
  'global.add-server':            { combo: null,                                           scope: 'global',             label: 'Add server',               group: 'General' },
  'global.switch-server':         { combo: null,                                           scope: 'global',             label: 'Switch server…',           group: 'General' },
  'global.find-hosts':            { combo: null,                                           scope: 'global',             label: 'Find hosts nearby',        group: 'General' },
} as const satisfies Record<string, BindingDef>

export type BindingId = keyof typeof KEYBINDINGS

/** All bindings for a given scope, preserving declaration order. */
export function bindingsForScope(scope: string): Array<[BindingId, BindingDef]> {
  // SAFETY: KEYBINDINGS is a closed declaration whose keys define BindingId.
  return (Object.entries(KEYBINDINGS) as Array<[BindingId, BindingDef]>)
    .filter(([, def]) => def.scope === scope)
}

/**
 * Platform-aware combo hint for inline UI labels/tooltips (e.g. "⌘B").
 * Reflects the effective default for the current platform; ignores user
 * overrides (matching how these static hints behaved before they were editable).
 * Empty for a binding that ships unassigned.
 */
export function comboHint(id: BindingId): string {
  const combo = defaultCombo(KEYBINDINGS[id])
  return combo ? formatCombo(combo).join('') : ''
}
