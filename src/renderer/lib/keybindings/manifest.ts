import type { BindingDef } from './types'
import { defaultCombo, formatCombo } from './match'

export const KEYBINDINGS = {
  // ── Global ─────────────────────────────────────────────────────────────────
  'global.select-project':    { combo: { mod: true, code: 'KeyO' }, web: { alt: true, shift: true, code: 'KeyO' }, scope: 'global', label: 'Select project',           group: 'General' },
  'global.new-tab':           { combo: { mod: true, code: 'KeyT' }, web: { alt: true, shift: true, code: 'KeyT' }, scope: 'global', label: 'New tab',                  group: 'Tabs' },
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
  'global.continue-in-mode':  { combo: { alt: true, shift: true, code: 'KeyE' },          scope: 'global',             label: 'Continue in editor / pill', group: 'View' },
  'global.toggle-diff-panel':    { combo: { alt: true, shift: true, code: 'KeyD' },        scope: 'global',             label: 'Toggle diff panel',        group: 'View' },
  'global.toggle-files':         { combo: { alt: true, shift: true, code: 'KeyO' },        scope: 'global',             label: 'Open files',               group: 'View' },
  'global.open-in-split': { combo: { alt: true, shift: true, code: 'Backslash' }, scope: 'global',             label: 'Open artifact in split',   group: 'View' },
  'global.toggle-project-panel': { combo: { alt: true, code: 'KeyM' },                   scope: 'global',             label: 'Toggle project panel',     group: 'View' },
  'global.toggle-run-dock':      { combo: { alt: true, code: 'KeyJ' },                    scope: 'global',             label: 'Toggle run logs',          group: 'View' },
  'global.toggle-plans':         { combo: { alt: true, shift: true, code: 'KeyL' },       scope: 'global',             label: 'Open plans gallery',       group: 'View' },
  'global.toggle-folio':      { combo: { alt: true, shift: true, code: 'Semicolon' },     scope: 'global',             label: 'Open folio gallery',       group: 'View' },
  'global.toggle-automations': { combo: { alt: true, shift: true, code: 'KeyV' },          scope: 'global',             label: 'Open automations',         group: 'View' },
  'global.toggle-tasks':       { combo: { alt: true, shift: true, code: 'KeyT' },          scope: 'global',             label: 'Open tasks',               group: 'View' },
  'global.toggle-sidebar':     { combo: { mod: true, code: 'KeyB' },                       scope: 'global',             label: 'Toggle sidebar',           group: 'View' },
  'global.toggle-expanded':   { combo: { alt: true, shift: true, code: 'Equal' },         scope: 'global',             label: 'Expand / collapse input',  group: 'View' },
  'global.session-picker':    { combo: { mod: true, code: 'KeyP' }, web: { alt: true, shift: true, code: 'KeyR' }, scope: 'global', label: 'Session picker',           group: 'Navigation' },
  'global.session-picker-j': { combo: { alt: true, shift: true, code: 'KeyJ' },          scope: 'global',             label: 'Session picker (alt)',     group: 'Navigation' },
  'global.cycle-perm-mode':   { combo: { alt: true, shift: true, code: 'Tab' },           scope: 'global',             label: 'Cycle permission mode',    group: 'Agent' },
  'global.cycle-model':       { combo: { alt: true, shift: true, code: 'KeyM' },          scope: 'global',             label: 'Cycle model',              group: 'Agent' },
  'global.cycle-agent':       { combo: { alt: true, shift: true, code: 'KeyG' },          scope: 'global',             label: 'Cycle agent',              group: 'Agent' },
  'global.toggle-reasoning':  { combo: { alt: true, shift: true, code: 'KeyZ' },          scope: 'global',             label: 'Open model menu',          group: 'Agent' },
  'global.settings':          { combo: { mod: true, code: 'Comma' },                      scope: 'global',             label: 'Settings',                 group: 'General' },
  'global.focus-input':       { combo: { mod: true, code: 'KeyL' }, web: { alt: true, code: 'KeyL' }, scope: 'global',  label: 'Focus input',              group: 'General' },
  'global.toggle-worktree':   { combo: { alt: true, shift: true, code: 'KeyB' },          scope: 'global',             label: 'Toggle worktree mode',     group: 'Git' },
  'global.switch-worktree':   { combo: { alt: true, shift: true, code: 'KeyH' },          scope: 'global',             label: 'Switch worktree',          group: 'Git' },
  'global.continue-worktree': { combo: { alt: true, code: 'KeyW' },                       scope: 'global',             label: 'Continue in worktree',     group: 'Git' },
  'global.git-open-terminal': { combo: { alt: true, shift: true, code: 'KeyY' },          scope: 'global',             label: 'Open worktree in terminal', group: 'Git' },
  'global.show-shortcuts':    { combo: { mod: true, code: 'Slash' },                      scope: 'global',             label: 'Keyboard shortcuts',       group: 'General' },
  'global.command-palette':   { combo: { mod: true, code: 'KeyK' },                       scope: 'global',             label: 'Command palette',          group: 'General' },

  // ── Voice (global, gated by viewMode + not read-only) ──────────────────────
  'voice.toggle-mode':        { combo: { alt: true, shift: true, code: 'KeyV' },          scope: 'global',             label: 'Toggle voice mode',        group: 'Voice' },
  'voice.toggle-recorder':    { combo: { alt: true, shift: true, code: 'KeyK' },          scope: 'global',             label: 'Toggle voice recording',   group: 'Voice' },

  // ── Action orb (global, gated by active tab) ───────────────────────────────
  'orb.toggle':               { combo: { alt: true, shift: true, code: 'KeyQ' },          scope: 'global',             label: 'Toggle quick actions',     group: 'General' },
  'orb.open-terminal':        { combo: { alt: true, shift: true, code: 'Backquote' },     scope: 'global',             label: 'Open terminal',            group: 'General' },
  'orb.commit-push':          { combo: { alt: true, shift: true, code: 'KeyC' },          scope: 'global',             label: 'Commit and push',          group: 'General' },
  'orb.sync':                 { combo: { alt: true, shift: true, code: 'Period' },        scope: 'global',             label: 'Sync (pull)',              group: 'General' },
  'orb.pin':                  { combo: { alt: true, shift: true, code: 'KeyX' },          scope: 'global',             label: 'Pin / unpin session',      group: 'General' },

  // ── Conversation (global, gated by active tab) ─────────────────────────────
  'conversation.scroll-top':      { combo: { alt: true, code: 'KeyH' },                   scope: 'global',             label: 'Scroll to first message',  group: 'Conversation' },
  'conversation.scroll-bottom':   { combo: { alt: true, code: 'KeyE' },                   scope: 'global',             label: 'Scroll to bottom',         group: 'Conversation' },
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

  // ── Files pane ─────────────────────────────────────────────────────────────
  'files-pane.close':             { combo: { code: 'Escape' },                             scope: 'files-pane',         label: 'Close files',              group: 'Panel' },
  'files-pane.toggle-tree':       { combo: { alt: true, code: 'KeyT' },                    scope: 'files-pane',         label: 'Toggle file tree',         group: 'Navigate' },
  'files-pane.focus-search':      { combo: { code: 'Slash' },                              scope: 'files-pane',         label: 'Focus search',             group: 'Navigate' },
  'files-pane.next-file':         { combo: { alt: true, code: 'KeyJ' },                    scope: 'files-pane',         label: 'Next file',                group: 'Navigate' },
  'files-pane.prev-file':         { combo: { alt: true, code: 'KeyK' },                    scope: 'files-pane',         label: 'Previous file',            group: 'Navigate' },

  // ── Plan gallery ───────────────────────────────────────────────────────────
  'plan-gallery.close':           { combo: { code: 'Escape' },                             scope: 'plan-gallery',       label: 'Close',                    group: 'Gallery' },
  'plan-gallery.focus-search':    { combo: { code: 'Slash' },                              scope: 'plan-gallery',       label: 'Focus search',             group: 'Gallery' },
  'plan-gallery.open':            { combo: { code: 'Enter' },                              scope: 'plan-gallery',       label: 'Open plan',                group: 'Gallery' },
  'plan-gallery.resume':          { combo: { shift: true, code: 'Enter' },                 scope: 'plan-gallery',       label: 'Resume session',           group: 'Gallery' },
  'plan-gallery.next':            { combo: { code: 'ArrowRight' },                         scope: 'plan-gallery',       label: 'Next (grid)',              group: 'Navigate' },
  'plan-gallery.prev':            { combo: { code: 'ArrowLeft' },                          scope: 'plan-gallery',       label: 'Previous (grid)',          group: 'Navigate' },
  'plan-gallery.down':            { combo: { code: 'ArrowDown' },                          scope: 'plan-gallery',       label: 'Down',                     group: 'Navigate' },
  'plan-gallery.up':              { combo: { code: 'ArrowUp' },                            scope: 'plan-gallery',       label: 'Up',                       group: 'Navigate' },
  'plan-gallery.toggle-bookmark': { combo: { alt: true, code: 'KeyB' },                    scope: 'plan-gallery',       label: 'Toggle bookmark',          group: 'Gallery' },

  // ── Plan review ────────────────────────────────────────────────────────────
  'plan-review.approve-ask':      { combo: { alt: true, code: 'KeyY' },                    scope: 'plan-action-bar',    label: 'Approve (ask mode)',       group: 'Review' },
  'plan-review.approve-auto':     { combo: { alt: true, code: 'KeyA' },                    scope: 'plan-action-bar',    label: 'Approve (auto mode)',      group: 'Review' },
  'plan-review.reject':           { combo: { alt: true, code: 'KeyR' },                    scope: 'plan-action-bar',    label: 'Reject',                   group: 'Review' },
  'plan-review.reject-revise':    { combo: { alt: true, code: 'KeyV' },                    scope: 'plan-action-bar',    label: 'Reject with feedback',     group: 'Review' },
  'plan-review.focus-comment':    { combo: { alt: true, code: 'KeyL' },                    scope: 'plan-action-bar',    label: 'Focus comment field',      group: 'Review' },
  'plan-review.toggle-worktree':  { combo: { alt: true, code: 'KeyW' },                    scope: 'plan-action-bar',    label: 'Toggle worktree',          group: 'Review' },

  // ── Plan modal ─────────────────────────────────────────────────────────────
  'plan-modal.close':             { combo: { code: 'Escape' },                             scope: 'plan-modal',         label: 'Close',                    group: 'Modal' },
  'plan-modal.start-comment':     { combo: { mod: true, code: 'KeyM' },                    scope: 'plan-modal',         label: 'Comment on selection',     group: 'Modal' },
  'plan-modal.save':              { combo: { alt: true, code: 'KeyS' },                    scope: 'plan-modal',         label: 'Save',                     group: 'Modal' },
  'plan-modal.copy':              { combo: { alt: true, code: 'KeyC' },                    scope: 'plan-modal',         label: 'Copy to clipboard',        group: 'Modal' },
  'plan-modal.toggle-bookmark':   { combo: { alt: true, code: 'KeyB' },                    scope: 'plan-modal',         label: 'Toggle bookmark',          group: 'Modal' },
  'plan-modal.toggle-comments':   { combo: { alt: true, code: 'KeyM' },                    scope: 'plan-modal',         label: 'Toggle comments',          group: 'Modal' },
  'plan-modal.resume':            { combo: { alt: true, code: 'KeyO' },                    scope: 'plan-modal',         label: 'Resume session',           group: 'Modal' },
  'plan-modal.find':              { combo: { mod: true, code: 'KeyF' },                    scope: 'plan-modal',         label: 'Find & replace',           group: 'Modal' },
  'plan-modal.new-tab':           { combo: { mod: true, code: 'KeyT' }, web: { alt: true, shift: true, code: 'KeyT' }, scope: 'plan-modal', label: 'New tab',         group: 'Modal' },

  // ── Document modal ─────────────────────────────────────────────────────────
  'document-modal.close':         { combo: { code: 'Escape' },                             scope: 'document-modal',     label: 'Close',                    group: 'Modal' },
  'document-modal.save':          { combo: { alt: true, code: 'KeyS' },                    scope: 'document-modal',     label: 'Save',                     group: 'Modal' },
  'document-modal.copy':          { combo: { alt: true, code: 'KeyC' },                    scope: 'document-modal',     label: 'Copy to clipboard',        group: 'Modal' },
  'document-modal.find':          { combo: { mod: true, code: 'KeyF' },                    scope: 'document-modal',     label: 'Find & replace',           group: 'Modal' },
  'document-modal.google-upload': { combo: { alt: true, code: 'KeyG' },                    scope: 'document-modal',     label: 'Open in Google Docs',      group: 'Modal' },
  'plan-modal.google-upload':     { combo: { alt: true, code: 'KeyG' },                    scope: 'plan-modal',         label: 'Open in Google Docs',      group: 'Modal' },

  // ── Folio gallery ──────────────────────────────────────────────────────────
  'folio-gallery.close':          { combo: { code: 'Escape' },                             scope: 'folio-gallery',      label: 'Close',                    group: 'Gallery' },
  'folio-gallery.focus-search':   { combo: { code: 'Slash' },                              scope: 'folio-gallery',      label: 'Focus search',             group: 'Gallery' },
  'folio-gallery.open':           { combo: { code: 'Enter' },                              scope: 'folio-gallery',      label: 'Open document',            group: 'Gallery' },
  'folio-gallery.next':           { combo: { code: 'ArrowDown' },                          scope: 'folio-gallery',      label: 'Next',                     group: 'Navigate' },
  'folio-gallery.prev':           { combo: { code: 'ArrowUp' },                            scope: 'folio-gallery',      label: 'Previous',                 group: 'Navigate' },
  'folio-gallery.delete':         { combo: { alt: true, code: 'Backspace' },               scope: 'folio-gallery',      label: 'Delete document',          group: 'Gallery' },

  // ── Automations ────────────────────────────────────────────────────────────
  'automations.close':            { combo: { code: 'Escape' },                             scope: 'automations',        label: 'Close',                    group: 'Automations' },
  'automations.new':              { combo: { alt: true, code: 'KeyN' },                    scope: 'automations',        label: 'New automation',           group: 'Automations' },

  // ── Tasks ───────────────────────────────────────────────────────────────────
  'tasks.close':                  { combo: { code: 'Escape' },                             scope: 'tasks',              label: 'Close',                    group: 'Tasks' },

  // ── Pull Requests ──────────────────────────────────────────────────────────
  'prs.close':                    { combo: { code: 'Escape' },                             scope: 'prs',                label: 'Close',                    group: 'Pull Requests' },
  'prs.queue':                    { combo: { alt: true, code: 'KeyQ' },                    scope: 'prs',                label: 'Queue for merge',          group: 'Pull Requests' },
  'prs.queueView':                { combo: { alt: true, code: 'KeyM' },                    scope: 'prs',                label: 'Open merge queue',         group: 'Pull Requests' },

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

  // ── Command palette ────────────────────────────────────────────────────────
  'command-palette.close':        { combo: { code: 'Escape' },                             scope: 'command-palette',    label: 'Close',                    group: 'Palette' },
  'command-palette.next':         { combo: { code: 'ArrowDown' }, aliases: [{ ctrl: true, code: 'KeyN' }], repeatable: true, scope: 'command-palette',    label: 'Next command',             group: 'Palette' },
  'command-palette.prev':         { combo: { code: 'ArrowUp' }, aliases: [{ ctrl: true, code: 'KeyP' }],   repeatable: true, scope: 'command-palette',    label: 'Previous command',         group: 'Palette' },
  'command-palette.select':       { combo: { code: 'Enter' },                              scope: 'command-palette',    label: 'Run command',              group: 'Palette' },

  // ── Shortcuts help modal ───────────────────────────────────────────────────
  'shortcuts-help.close':         { combo: { code: 'Escape' },                             scope: 'shortcuts-help',     label: 'Close',                    group: 'Modal' },
} as const satisfies Record<string, BindingDef>

export type BindingId = keyof typeof KEYBINDINGS

/** All bindings for a given scope, preserving declaration order. */
export function bindingsForScope(scope: string): Array<[BindingId, BindingDef]> {
  return (Object.entries(KEYBINDINGS) as Array<[BindingId, BindingDef]>)
    .filter(([, def]) => def.scope === scope)
}

/**
 * Platform-aware combo hint for inline UI labels/tooltips (e.g. "⌘B").
 * Reflects the effective default for the current platform; ignores user
 * overrides (matching how these static hints behaved before they were editable).
 */
export function comboHint(id: BindingId): string {
  return formatCombo(defaultCombo(KEYBINDINGS[id])).join('')
}
