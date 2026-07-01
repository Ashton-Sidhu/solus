/**
 * Shared @pierre/trees unsafeCSS applied to every FileTree instance in the app.
 *
 * Pierre renders all tree icons at a fixed 16px. The folder chevron's glyph
 * fills nearly its whole viewBox, so at our smaller tree font it reads
 * oversized next to the text. Size it off the tree's own resolved font instead
 * of a fixed px/rem value, so it stays proportional to the label at every font
 * size and screen size. Width/height (not transform) keeps Pierre's own
 * rotate-for-collapsed and alignment-nudge transforms intact.
 */
export const FILE_TREE_CHEVRON_CSS = `
  [data-icon-name='file-tree-icon-chevron'] {
    width: calc(var(--trees-font-size) * 1.1);
    height: calc(var(--trees-font-size) * 1.1);
  }
`
