// The single boundary between Solus and @pierre/diffs' diff metadata: every
// surface reads its files through `parsePatchMetadata` (or normalizes a
// chunk-cached parse with `compactPartialHunkOffsets`), so one row coordinate
// space reaches the library from every surface.
//
// Render options live in `./options` rather than here on purpose: they resolve
// the theme through the diff worker pool, which reads browser storage on import,
// and metadata is pure.
export {
  clearPatchMetadataCache,
  collapseHunks,
  compactPartialHunkOffsets,
  parsePatchMetadata,
  patchMetadataCacheStats,
  type PatchMetadataCacheStats,
} from './metadata'
