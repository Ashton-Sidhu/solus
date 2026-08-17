/** Stack used for any monospace text inside the diff panel chrome and content. */
export const MONO_FONT = 'var(--solus-code-font-family)'

/**
 * Shared @pierre/diffs unsafeCSS — themes the shadow-DOM diff component to match
 * Solus's design tokens. Used by both `<Diff>` and `DiffStream`'s CodeView.
 */
export const DIFFS_THEME_CSS = `
  :host {
    /* Keep Pierre's color-mix base opaque, but do not paint it on the normal
       code surface below. The tree and code then reveal the same shared parent
       background while changed rows still get stable add/remove tints. */
    --diffs-bg: var(--solus-diff-surface) !important;
    --diffs-light-bg: var(--solus-diff-surface) !important;
    --diffs-dark-bg: var(--solus-diff-surface) !important;

    --diffs-fg-number-override: var(--solus-diff-gutter-text-vivid);

    --diffs-addition-color-override: var(--solus-diff-added-text-vivid);
    --diffs-bg-addition-override: var(--solus-diff-added-bg-vivid);
    --diffs-bg-addition-number-override: var(--solus-diff-added-number-vivid);
    --diffs-bg-addition-hover-override: var(--solus-diff-added-number-vivid);
    --diffs-bg-addition-emphasis-override: var(--solus-diff-added-emphasis-vivid);

    --diffs-deletion-color-override: var(--solus-diff-removed-text-vivid);
    --diffs-bg-deletion-override: var(--solus-diff-removed-bg-vivid);
    --diffs-bg-deletion-number-override: var(--solus-diff-removed-number-vivid);
    --diffs-bg-deletion-hover-override: var(--solus-diff-removed-number-vivid);
    --diffs-bg-deletion-emphasis-override: var(--solus-diff-removed-emphasis-vivid);

    /* Flat code surface: unchanged lines and the "N unmodified lines" gaps carry
       no wash of their own, so the only fills in the stream are the add/remove
       rows. Hunk gaps still read as gaps via their chevrons and label colour. */
    --diffs-bg-separator-override: transparent;

    --diffs-bg-context-override: transparent;
    --diffs-bg-hover-override: var(--solus-surface-hover);
    --diffs-bg-buffer-override: var(--solus-surface-hover);

    --diffs-bg-selection-override: var(--solus-diff-line-selection-bg);
    --diffs-bg-selection-number-override: var(--solus-diff-line-selection-bg);

    /* The editable-file tokenizer writes --diffs-editor-selection-bg via its
       own unlayered style tag, falling back to the (unset at :host)
       --diffs-line-bg whenever the active theme has no editor.selectionBackground
       (true for both github-*-default themes) — so the text-selection highlight
       renders fully transparent. Our unsafeCSS lives in the "unsafe" layer,
       which always loses to unlayered rules regardless of source order, so only
       !important can out-prioritize it here. */
    --diffs-editor-selection-bg: var(--solus-diff-selection-bg) !important;

    --diffs-gap-inline: 1px;
    --diffs-gap-block: 8px;
    --diffs-gap-style: none;
  }
  /* The library paints its base on several nested wrappers. Keep those wrappers
     transparent so the pane remains the single surface layer. [data-line] is
     deliberately absent: it resolves --diffs-line-bg, which carries add/remove
     and selection tints. */
  :host,
  pre,
  code,
  [data-gutter],
  [data-content],
  [data-separator],
  [data-separator-wrapper] {
    background-color: transparent !important;
  }
  /* Context rows otherwise repaint --diffs-bg over the item surface. That is
     visibly lighter in the light theme and double-composites the translucent
     container colour in dark mode. Only changed/selected/hovered rows should
     paint a fill of their own. */
  [data-line-type='context']:not([data-selected-line]):not([data-hovered]) {
    background-color: transparent !important;
  }
  /* Annotation rows are layout space for comment cards, not diff lines. Pierre
     carries the anchor line's add/remove tint into these wrappers; blank it so
     only the card itself has a surface. */
  [data-line-annotation],
  [data-gutter-buffer='annotation'],
  [data-annotation-content],
  [data-annotation-slot] {
    background-color: transparent !important;
  }
  :host diffs-component pre {
    border-radius: 0 !important;
    margin: 0 !important;
    border: none !important;
    font-family: var(--solus-code-font-family) !important;
    font-size: inherit !important;
    line-height: inherit !important;
    letter-spacing: -0.005em !important;
    font-feature-settings: 'liga' 0, 'calt' 0 !important;
    -webkit-font-smoothing: antialiased !important;
  }
  :host diffs-component code,
  :host diffs-component span {
    font-family: inherit !important;
  }
  [data-separator='metadata'] {
    color: var(--solus-diff-hunk-text);
    font-size: 0.75em;
    font-style: italic;
    padding: 3px 0;
    letter-spacing: 0.01em;
    opacity: 0.7;
  }
  /* Expandable gaps: "N unchanged lines" with up/down chevrons and, on gaps
     bigger than one expansion chunk, "Expand all". The library packs those
     controls into a gutter-width grid that drops the last one onto a second row,
     so — following its own CustomHunkSeparators example — the wrapper becomes a
     max-content row anchored at the gutter's right edge and pulled back over the
     number column. Height stays 32px: the virtualizer hard-codes that for this
     separator type, so changing it desyncs scroll positions.

     Additions-side wrappers stay hidden (the library's own rule); matching only
     the unified / deletions gutter keeps split view from drawing them twice. */
  [data-diff-type='single'] [data-gutter],
  [data-diff-type='split'] [data-deletions] [data-gutter] {
    [data-separator='line-info-basic'] [data-separator-wrapper] {
      display: flex;
      align-items: center;
      inset-inline: auto;
      left: 100%;
      width: max-content;
      margin-left: calc(-2ch - 4px);
      background: transparent;
      color: var(--solus-diff-hunk-text);
      font-size: 0.85em;
      letter-spacing: 0.01em;
    }
    [data-separator='line-info-basic'] [data-expand-button],
    [data-separator='line-info-basic'] [data-separator-content] {
      align-self: center;
      flex: none;
      min-width: 0;
      height: auto;
      padding: 0;
      border: none;
      background: transparent;
      color: inherit;
      grid-column: unset;
    }
    [data-separator='line-info-basic'] [data-separator-content] {
      padding-inline: 0.75ch;
    }
    [data-separator='line-info-basic'] [data-expand-button] {
      width: 2ch;
      justify-content: center;
      border-radius: 3px;
      transition: color 120ms ease, transform 120ms ease;
    }
    [data-separator='line-info-basic'] [data-expand-button] svg {
      width: 9px;
      height: 9px;
    }
    [data-separator='line-info-basic'] [data-expand-button]:hover,
    [data-separator='line-info-basic'] [data-separator-content]:hover {
      color: var(--solus-accent);
    }
    [data-separator='line-info-basic'] [data-expand-button]:active {
      transform: scale(0.9);
    }
    /* Shipped display:none for consumers to opt into. It only renders when the
       gap is larger than a single expansion chunk. */
    [data-separator='line-info-basic'] [data-expand-button][data-expand-all-button] {
      display: flex;
      width: auto;
      margin-left: 0.75ch;
      padding-inline: 0.5ch;
      font-size: 0.95em;
    }
  }
  [data-column-number] {
    padding-left: 1.5ch;
  }
  /* No hairline between the gutter and the code column — the design separates
     them with whitespace alone, so the only vertical strokes in the stream are
     the change rails below.
     A 2px rail at the leading edge of every changed line. The row wash is
     deliberately faint (see the -vivid tokens in index.css), so the rail — not
     the fill — is what makes added/removed scannable down the gutter. Drawn as
     an inset shadow rather than a border so it costs no layout width. The 1.5ch
     padding above keeps the line numbers clear of it. */
  [data-column-number][data-line-type='change-addition'] {
    box-shadow: inset 2px 0 0 0 var(--solus-art-3);
  }
  [data-column-number][data-line-type='change-deletion'] {
    box-shadow: inset 2px 0 0 0 var(--solus-stop-bg);
  }
  [data-utility-button] {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background-color: var(--solus-accent);
    opacity: 0;
    transform: scale(0.8);
    transition: opacity 0.15s ease, transform 0.15s ease;
  }
  [data-column-number][data-hovered] [data-gutter-utility-slot] [data-utility-button],
  [data-utility-button]:hover {
    opacity: 1;
    transform: scale(1);
  }
  [data-utility-button]:active {
    transform: scale(0.92);
  }
  [data-utility-button] svg {
    width: 8px;
    height: 8px;
  }
  [data-gutter-utility-slot] {
    align-items: center;
    padding-right: 2px;
  }
  /* Unpinned, the header is part of the flat surface and paints nothing. */
  [data-diffs-header='default'] {
    min-height: 32px;
    height: 32px;
    padding-inline: 11px;
    background-color: transparent;
    font-size: 0.75rem;
    transition: background-color 160ms ease;
  }
  /* Pinned is the one place an opaque fill is required — otherwise the code
     scrolls visibly through the header. --solus-diff-surface is the opaque twin
     of the shared pane background. backdrop-filter: blur() would be the
     alternative, but it forces the
     browser to re-raster the scrolling code behind every pinned header on each
     frame — the single biggest cause of stutter on fast scroll. No
     border/shadow: the header sits flush with the code, separated only by the
     inter-file gap. */
  [data-diffs-header='default'][data-sticky] {
    background: var(--solus-diff-surface);
    z-index: 2;
  }
  [data-diffs-header='default']:hover {
    background-color: var(--solus-surface-hover);
  }
  [data-diffs-header='default'][data-sticky]:hover {
    background: linear-gradient(var(--solus-surface-hover), var(--solus-surface-hover)),
      var(--solus-diff-surface);
  }
  [data-header-content] {
    gap: 6px;
    min-width: 0;
    font-family: ${MONO_FONT};
  }
  /* @pierre/diffs wraps each slotted header element in a bare <div slot="...">.
     That wrapper is the flex item, and its default min-width: auto keeps it at
     the full path width — so on a narrow pane the path overflows
     [data-header-content] and paints over the stats and actions on the right
     instead of truncating. min-width: 0 lets it shrink; the stats side never
     shrinks, so the directory ellipsis absorbs the difference. */
  ::slotted([slot='header-prefix']) {
    min-width: 0;
  }
  /* The native title / rename chrome is replaced by a custom prefix rendered into
     the header-prefix slot (collapse chevron + file-type badge + dir/name split) —
     see DiffStream.buildHeaderPrefix. Hide the library's own title elements. */
  [data-header-content] [data-title],
  [data-header-content] [data-prev-name],
  [data-change-icon],
  [data-rename-icon] {
    display: none;
  }
  [data-diffs-header='default'] [data-metadata] {
    flex-shrink: 0;
    gap: 5px;
    font-family: ${MONO_FONT};
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }
  [data-additions-count],
  [data-deletions-count] {
    font-weight: 500;
    letter-spacing: 0;
    padding: 1px 5px;
    border-radius: 5px;
    line-height: 1.45;
  }
  [data-additions-count] {
    color: var(--solus-diff-added-text-vivid);
    background: var(--solus-diff-added-number-vivid);
  }
  [data-deletions-count] {
    color: var(--solus-diff-removed-text-vivid);
    background: var(--solus-diff-removed-number-vivid);
  }
  /* Moved blocks keep their syntax shape but recede to context strength. Only
     the character ranges changed inside a moved block regain vivid emphasis. */
  [data-solus-moved],
  [data-solus-moved] * {
    color: var(--solus-text-tertiary) !important;
    background-color: transparent !important;
  }
  [data-solus-move-edit] {
    color: var(--solus-text-primary) !important;
    border-radius: 2px;
  }
  [data-solus-move-edit='old'] {
    background-color: var(--solus-diff-removed-emphasis-vivid) !important;
  }
  [data-solus-move-edit='new'] {
    background-color: var(--solus-diff-added-emphasis-vivid) !important;
  }
  /* Ensure annotations land in the correct grid column in split+wrap mode.
     Without these, auto-placement can put additions-side annotations in cols 1-2. */
  [data-diff-type='split'][data-overflow='wrap'] [data-deletions] > [data-gutter-buffer='annotation'] {
    grid-column: 1;
  }
  [data-diff-type='split'][data-overflow='wrap'] [data-deletions] > [data-line-annotation] {
    grid-column: 2;
  }
  [data-diff-type='split'][data-overflow='wrap'] [data-additions] > [data-gutter-buffer='annotation'] {
    grid-column: 3;
  }
  [data-diff-type='split'][data-overflow='wrap'] [data-additions] > [data-line-annotation] {
    grid-column: 4;
  }
  /* Compact screens (laptops, iPad + keyboard): scale the file-header chrome
     down a notch so it stays proportional on smaller displays. The height here
     is mirrored by DiffStream's responsive \`diffHeaderHeight\` metric — keep the
     two in sync (DIFF_HEADER_HEIGHT_COMPACT). */
  @media (max-width: 1100px) {
    [data-diffs-header='default'] {
      min-height: 30px;
      height: 30px;
      padding-inline: 10px;
      font-size: 0.75rem;
    }
    [data-diffs-header='default'] [data-metadata] {
      font-size: 0.75rem;
    }
  }
  /* Phones / narrow windows: tightest tier so the filename + stats still fit on
     a small viewport. Height mirrors DIFF_HEADER_HEIGHT_PHONE in DiffStream.
     Must follow the compact block so it wins by source order. */
  @media (max-width: 767px) {
    [data-diffs-header='default'] {
      min-height: 28px;
      height: 28px;
      padding-inline: 9px;
      font-size: 0.75rem;
    }
    [data-diffs-header='default'] [data-metadata] {
      font-size: 0.75rem;
    }
  }
`

/**
 * Find-in-diff highlight rules. Appended to the CodeView `unsafeCSS` so they
 * land inside every diff shadow root (Svelte `<style>` can't cross the boundary,
 * and the highlighted text nodes live in the shadow tree). The `--solus-diff-find*`
 * tokens are defined on :root/.dark in index.css and inherit through the host.
 */
export const DIFF_FIND_HIGHLIGHT_CSS = `
  ::highlight(solus-diff-find) {
    background-color: var(--solus-diff-find-bg);
    color: var(--solus-diff-find-text);
  }
  ::highlight(solus-diff-find-active) {
    background-color: var(--solus-diff-find-active-bg);
    color: var(--solus-diff-find-active-text);
  }
`
