import { FileTree, type GitStatusEntry } from "@pierre/trees";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { DiffComment } from "../../../../shared/types";
import { FILE_TREE_CHEVRON_CSS } from "../../../lib/fileTreeTheme";
import { createRowDecorationRenderer } from "../../../lib/diffTreeAdapter";

const DIFF_TREE_CSS = `
  [data-type='item'][data-item-selected='true']::after {
    content: '';
    position: absolute;
    top: 0.1875rem; bottom: 0.1875rem; left: 0;
    width: 0.1563rem;
    border-radius: 0 0.1875rem 0.1875rem 0;
    background: var(--solus-accent);
  }
  [data-type='item'][data-item-selected='true']::before {
    outline-color: transparent !important;
  }
  [data-item-section='icon'] { cursor: pointer; }
  ${FILE_TREE_CHEVRON_CSS}
  [data-item-section='decoration'] {
    font-variant-numeric: tabular-nums;
    font-size: 0.5938rem;
    letter-spacing: 0.01em;
    opacity: 0.75;
  }
  [data-item-selected='true'] [data-item-section='decoration'],
  [data-item-focused='true'] [data-item-section='decoration'] { opacity: 1; }
  [data-file-tree-search-container] {
    padding-top: 0.375rem;
    padding-left: calc(var(--trees-padding-inline) + 2.125rem);
    margin-bottom: 0.625rem;
  }
  [data-file-tree-search-input] { min-width: 0; }
`;

interface MountDiffFileTreeOptions {
  node: HTMLDivElement;
  paths: string[];
  gitStatus: GitStatusEntry[];
  files: FileDiffMetadata[];
  comments: DiffComment[];
  onSelect: (path: string) => void;
}

export function mountDiffFileTree({
  node,
  paths,
  gitStatus,
  files,
  comments,
  onSelect,
}: MountDiffFileTreeOptions): { tree: FileTree; destroy: () => void } {
  const tree = new FileTree({
    paths,
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    gitStatus,
    search: true,
    searchBlurBehavior: "close",
    renderRowDecoration: createRowDecorationRenderer(files, comments),
    onSelectionChange: (selectedPaths) => {
      const next = selectedPaths[0];
      if (next) onSelect(next);
    },
    unsafeCSS: DIFF_TREE_CSS,
  });
  tree.render({ containerWrapper: node });

  function handleIconClick(event: MouseEvent) {
    const elements = event.composedPath().filter(
      (target): target is HTMLElement => target instanceof HTMLElement,
    );
    const icon = elements.find((element) => element.dataset.itemSection === "icon");
    const row = elements.find(
      (element) =>
        element.dataset.type === "item" && element.dataset.itemType === "folder",
    );
    const path = row?.dataset.itemPath;
    if (!icon || !path) return;
    event.stopPropagation();
    const item = tree.getItem(path);
    if (item?.isDirectory() && "toggle" in item) item.toggle();
  }

  node.addEventListener("click", handleIconClick, true);
  return {
    tree,
    destroy() {
      node.removeEventListener("click", handleIconClick, true);
      tree.cleanUp();
    },
  };
}
