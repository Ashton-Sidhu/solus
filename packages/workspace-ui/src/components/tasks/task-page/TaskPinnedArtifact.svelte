<script lang="ts">
  import { PinOff as PinOffIcon, PanelRight as PanelRightIcon } from "@lucide/svelte";
  import type { TaskLink } from "@solus/contracts/task-types";
  import ArtifactView from "../../artifact/ArtifactView.svelte";

  /**
   * The one artifact a task opens with. Everything else on the task stays a row
   * in the linked table; this render is the one the reader asked to see first,
   * so it is open rather than a disclosure they have to find.
   */
  interface Props {
    link: TaskLink;
    /** The work's HTML once loaded, null until then. Read from the store. */
    html: string | null;
    /** False while the page is mounted but hidden. A hidden task page must not
     *  keep a live frame: the pin is remembered, the iframe is not. */
    enabled: boolean;
    onOpen: (link: TaskLink) => void;
    onUnpin: (link: TaskLink) => void;
  }

  let { link, html, enabled, onOpen, onUnpin }: Props = $props();

  const title = $derived(link.liveTitle || link.title);
</script>

<div
  class="mb-3 overflow-hidden rounded-xl border-[.5px] border-[color-mix(in_oklch,var(--hairline)_60%,transparent)]"
  data-testid="task-pinned-artifact"
>
  <div class="flex items-center gap-2 border-b-[.5px] border-[color-mix(in_oklch,var(--hairline)_60%,transparent)] px-2.5 py-1.5">
    <span class="shrink-0 font-medium uppercase tracking-wide text-muted-foreground opacity-70">Pinned</span>
    <span class="min-w-0 flex-1 truncate font-medium">{title}</span>
    <button
      type="button"
      class="flex h-[22px] shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 font-medium text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground"
      onclick={() => onOpen(link)}
    >
      <PanelRightIcon size={11} />
      Open
    </button>
    <button
      type="button"
      class="flex h-[22px] shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 font-medium text-muted-foreground hover:bg-[var(--wash-2)] hover:text-foreground"
      onclick={() => onUnpin(link)}
      data-testid="task-pinned-artifact-unpin"
    >
      <PinOffIcon size={11} />
      Unpin
    </button>
  </div>
  <div class="px-2 py-2">
    {#if !enabled}
      <div class="px-1 py-3 text-muted-foreground" role="status">Render paused while this page is hidden.</div>
    {:else if html}
      <ArtifactView artifact={{ kind: "html", html }} skipMotion />
    {:else}
      <div class="px-1 py-3 text-muted-foreground" role="status">Loading artifact…</div>
    {/if}
  </div>
</div>
