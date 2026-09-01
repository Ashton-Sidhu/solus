/**
 * A portable, visible file name for a work being written out to the filesystem.
 * Titles are free text — separators, colons and emoji all reach here — so every
 * character that a file name cannot carry collapses to an underscore. The
 * result uses lowercase snake case so work and plan exports have one stable
 * naming rule.
 */
export function exportFileName(title: string, extension: string, fallbackBase = "work"): string {
  const base = title.trim().toLowerCase().replace(/[^\w.\-]+/g, "_") || fallbackBase;
  return `${base}.${extension.toLowerCase()}`;
}
