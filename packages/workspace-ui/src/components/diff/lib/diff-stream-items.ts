import type { CodeViewItem, FileDiffMetadata } from "@pierre/diffs";

/**
 * CodeView.setItems keeps a reused record's old item unless its `version`
 * changes. A live refresh hands an edited file a new FileDiffMetadata (the
 * diff state reuses the parse object for an unchanged file), so compare
 * identities: publish a new version only when what the record shows differs.
 */
export function structuralItemVersion<Meta>(
  current: CodeViewItem<Meta> | undefined,
  fileDiff: FileDiffMetadata,
  collapsed: boolean,
): number {
  if (current?.type !== "diff") return 0;
  if (current.fileDiff === fileDiff && (current.collapsed === true) === collapsed)
    return current.version ?? 0;
  return (current.version ?? 0) + 1;
}
