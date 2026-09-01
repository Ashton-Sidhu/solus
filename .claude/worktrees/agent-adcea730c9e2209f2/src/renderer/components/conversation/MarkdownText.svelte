<script lang="ts" module>
  import { tokenClassName } from "../editor/tokenStyle";
  import { FILE_ICON_VIEWBOX, getFileIconPath, FOLDER_ICON_PATH } from "../editor/fileIcons";

  type Segment =
    | { type: "text"; value: string }
    | { type: "file"; path: string }
    | { type: "slash"; command: string };

  /*
   * `@path` — must start at boundary, runs until whitespace.
   * `/cmd`  — must start at boundary, ASCII letters/digits/`-`/`_`,
   *           and must NOT be immediately followed by another path
   *           segment or file extension (avoids matching `/usr/local`,
   *           `/test.svelte`, etc.).
   */
  const FILE_RE = /(?:^|(?<=\s))@[^\s]+/g;
  const SLASH_RE = /(?:^|(?<=\s))\/[a-zA-Z][a-zA-Z0-9_-]*(?![\w./])/g;

  const HTML_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
  const decodeHtml = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39);/g, m => HTML_ENTITIES[m]);

  function basename(path: string): string {
    const stripped = path.replace(/\/+$/, "");
    const idx = stripped.lastIndexOf("/");
    return idx === -1 ? stripped : stripped.slice(idx + 1);
  }

  export function tokenize(text: string): Segment[] {
    text = decodeHtml(text);
    type Hit = { start: number; end: number; seg: Segment };
    const hits: Hit[] = [];

    for (const m of text.matchAll(FILE_RE)) {
      hits.push({
        start: m.index!,
        end: m.index! + m[0].length,
        seg: { type: "file", path: m[0].slice(1) },
      });
    }
    for (const m of text.matchAll(SLASH_RE)) {
      hits.push({
        start: m.index!,
        end: m.index! + m[0].length,
        seg: { type: "slash", command: m[0] },
      });
    }
    hits.sort((a, b) => a.start - b.start);

    const out: Segment[] = [];
    let cursor = 0;
    for (const h of hits) {
      if (h.start < cursor) continue; // overlapping; first wins
      if (h.start > cursor) out.push({ type: "text", value: text.slice(cursor, h.start) });
      out.push(h.seg);
      cursor = h.end;
    }
    if (cursor < text.length) out.push({ type: "text", value: text.slice(cursor) });
    return out;
  }
</script>

<script lang="ts">
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { requestFilePreview } from "../../lib/filePreview";

  let { text = "" }: { text?: string } = $props();

  const session = getWorkspaceContext();

  const segments = $derived(tokenize(text));

  function handleFileClick(path: string) {
    requestFilePreview({ path, tabId: session.activeTabId });
  }
</script>

{#each segments as seg, i (i)}
  {#if seg.type === "text"}{seg.value}{:else if seg.type === "file"}{@const isDir = seg.path.endsWith('/')}<button
      type="button"
      class={tokenClassName("file")}
      title={seg.path}
      onclick={() => handleFileClick(seg.path)}
    >
      <span class="solus-token__icon">
        <svg viewBox={FILE_ICON_VIEWBOX} fill="currentColor"><path d={isDir ? FOLDER_ICON_PATH : getFileIconPath(basename(seg.path))} /></svg>
      </span>
      <span>{basename(seg.path)}</span>
    </button>{:else}<span class={tokenClassName("slash", true)}>{seg.command}</span>{/if}
{/each}
