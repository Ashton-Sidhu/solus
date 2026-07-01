/** Stack used for any monospace text inside the diff panel chrome and content. */
export const MONO_FONT = 'var(--solus-code-font-family)'

/**
 * Shared @pierre/diffs unsafeCSS — themes the shadow-DOM diff component to match
 * Solus's design tokens. Used by both `<Diff>` and `DiffStream`'s CodeView.
 */
export const DIFFS_THEME_CSS = `
  :host {
    --diffs-light-bg: var(--solus-container-bg);
    --diffs-dark-bg: var(--solus-container-bg);

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

    --diffs-bg-separator-override: var(--solus-diff-hunk-bg);

    --diffs-bg-context-override: transparent;
    --diffs-bg-hover-override: var(--solus-surface-hover);
    --diffs-bg-buffer-override: var(--solus-surface-hover);

    --diffs-bg-selection-override: var(--solus-diff-selection-bg);
    --diffs-bg-selection-number-override: var(--solus-diff-selection-bg);

    --diffs-gap-inline: 1px;
    --diffs-gap-block: 8px;
    --diffs-gap-style: none;
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
  [data-separator] {
    color: var(--solus-diff-hunk-text);
    font-size: 0.75em;
    font-style: italic;
    padding: 3px 0;
    letter-spacing: 0.01em;
    opacity: 0.7;
  }
  [data-column-number] {
    padding-left: 1.5ch;
  }
  /* Hairline separating the line-number gutter from the code column. */
  [data-gutter] [data-column-number] {
    border-right: 1px solid var(--solus-file-slot-divider);
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
  [data-diffs-header='default'] {
    min-height: 32px;
    height: 32px;
    padding-inline: 11px;
    background-color: var(--solus-container-bg);
    font-size: 11.5px;
    transition: background-color 160ms ease;
  }
  /* Solid (not frosted) sticky background. backdrop-filter: blur() forces the
     browser to re-raster the scrolling code behind every pinned header on each
     frame, which is the single biggest cause of stutter on fast scroll — so we
     use an opaque fill instead. No border/shadow: the header sits flush with the
     code, separated only by the inter-file gap. */
  [data-diffs-header='default'][data-sticky] {
    background: var(--solus-container-bg);
    z-index: 2;
  }
  [data-diffs-header='default']:hover {
    background-color: var(--solus-surface-hover);
  }
  [data-diffs-header='default'][data-sticky]:hover {
    background: linear-gradient(var(--solus-surface-hover), var(--solus-surface-hover)),
      var(--solus-container-bg);
  }
  [data-header-content] {
    gap: 6px;
    min-width: 0;
    font-family: ${MONO_FONT};
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
    gap: 5px;
    font-family: ${MONO_FONT};
    font-size: 9.5px;
    font-variant-numeric: tabular-nums;
  }
  [data-additions-count],
  [data-deletions-count] {
    font-weight: 600;
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
      font-size: 11px;
    }
    [data-diffs-header='default'] [data-metadata] {
      font-size: 9px;
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
      font-size: 10.5px;
    }
    [data-diffs-header='default'] [data-metadata] {
      font-size: 9px;
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
