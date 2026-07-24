import type { FileDiffMetadata } from "@pierre/diffs";
import type { DiffFileMoveSummary } from "../../../lib/diff-moves";
import {
  analyzeDiffNoise,
  collapseFormatOnlyHunks,
  diffNoiseLabel,
} from "../../../lib/diff-noise";

export class DiffCollapseState {
  private collapsed = new Set<string>();
  private autoCollapsed = new Set<string>();
  private reviewedAuto = new Set<string>();
  private expandedFormat = new Set<string>();
  private identityByPath = new Map<string, FileDiffMetadata>();

  prepare(file: FileDiffMetadata, moved: DiffFileMoveSummary | undefined): boolean {
    const previous = this.identityByPath.get(file.name);
    if (previous !== file) {
      this.identityByPath.set(file.name, file);
      this.reviewedAuto.delete(file.name);
      this.expandedFormat.delete(file.name);
      if (this.autoCollapsed.delete(file.name)) this.collapsed.delete(file.name);
    }
    const auto = !this.reviewedAuto.has(file.name) &&
      (analyzeDiffNoise(file).autoCollapse || moved?.allChangesMovedUnchanged === true);
    if (auto) {
      this.autoCollapsed.add(file.name);
      this.collapsed.add(file.name);
    } else if (this.autoCollapsed.delete(file.name)) {
      this.collapsed.delete(file.name);
    }
    return this.collapsed.has(file.name);
  }

  setCollapsed(path: string, collapsed: boolean): void {
    if (collapsed) {
      this.collapsed.add(path);
      return;
    }
    this.collapsed.delete(path);
    if (this.autoCollapsed.delete(path)) this.reviewedAuto.add(path);
  }

  isUnreviewed(path: string): boolean {
    const file = this.identityByPath.get(path);
    return this.autoCollapsed.has(path) || (!!file && this.hasCollapsedFormat(file));
  }

  displayFile(file: FileDiffMetadata): FileDiffMetadata {
    return this.expandedFormat.has(file.name) ? file : collapseFormatOnlyHunks(file);
  }

  hasCollapsedFormat(file: FileDiffMetadata): boolean {
    const count = analyzeDiffNoise(file).formatOnlyHunks.length;
    return count > 0 && count < file.hunks.length && !this.expandedFormat.has(file.name);
  }

  expandFormat(file: FileDiffMetadata): boolean {
    if (!this.hasCollapsedFormat(file)) return false;
    this.expandedFormat.add(file.name);
    return true;
  }
}

export function diffErgonomicsLabel(
  file: FileDiffMetadata,
  moved: DiffFileMoveSummary | undefined,
  unreviewed: boolean,
): string | null {
  const noise = analyzeDiffNoise(file);
  if (noise.kind) {
    return unreviewed
      ? `${diffNoiseLabel(noise)} · unreviewed`
      : `${noise.lineCount.toLocaleString()} line${noise.lineCount === 1 ? "" : "s"} · ${noise.kind}`;
  }
  if (noise.formatOnlyHunks.length > 0) {
    const count = noise.formatOnlyHunks.length;
    const summary = `${noise.formatOnlyLineCount.toLocaleString()} line${noise.formatOnlyLineCount === 1 ? "" : "s"} · ${count} format-only hunk${count === 1 ? "" : "s"}`;
    return unreviewed ? `${summary} · collapsed · unreviewed` : summary;
  }
  if (!moved?.unchangedMovedLines && !moved?.modifiedMovedLines) return null;
  const count = moved.unchangedMovedLines + moved.modifiedMovedLines;
  const suffix = moved.modifiedMovedLines > 0 ? "moved with edits" : "moved (unchanged)";
  return `${count.toLocaleString()} line${count === 1 ? "" : "s"} · ${suffix}${unreviewed ? " · collapsed · unreviewed" : ""}`;
}

export function appendDiffErgonomicsLabel(
  container: HTMLElement,
  file: FileDiffMetadata,
  moved: DiffFileMoveSummary | undefined,
  unreviewed: boolean,
  expandFormat: (() => void) | null,
): void {
  const text = diffErgonomicsLabel(file, moved, unreviewed);
  if (!text) return;
  const label = document.createElement(expandFormat ? "button" : "span");
  label.className = `diff-ergonomics-label${unreviewed ? " is-unreviewed" : ""}`;
  label.textContent = text;
  if (label instanceof HTMLButtonElement && expandFormat) {
    label.type = "button";
    label.setAttribute("aria-label", `Expand ${text}`);
    label.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      expandFormat();
    });
  }
  container.appendChild(label);
}
