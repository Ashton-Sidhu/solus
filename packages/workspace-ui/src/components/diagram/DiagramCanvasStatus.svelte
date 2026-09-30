<script lang="ts">
  import { Panel } from "@xyflow/svelte";

  interface Props {
    threadTotal: number;
    threadUnread: number;
    onOpenThreads: () => void;
    isFocused: boolean;
    onClearFocus: () => void;
    /** "Auto-layout · LR", or null before any layout was applied. */
    layoutStatus: string | null;
    layoutPristine: boolean;
  }

  let { threadTotal, threadUnread, onOpenThreads, isFocused, onClearFocus, layoutStatus, layoutPristine }: Props =
    $props();
</script>

{#if isFocused || layoutStatus || threadTotal > 0}
  <Panel position="top-right">
    <div class="canvas-status">
      {#if threadTotal > 0}
        <!-- Left of the layout pill: what is still open on this diagram,
             and a way straight to the thread Solus has spoken in. -->
        <button
          type="button"
          class="threads-pill"
          onclick={onOpenThreads}
          title={threadUnread > 0
            ? "Go to the first unread thread"
            : "Show every thread on this diagram"}
        >
          <span class="threads-pill__dot" aria-hidden="true"></span>
          {threadTotal}
          {threadTotal === 1 ? "thread" : "threads"}
          {#if threadUnread > 0}
            <span class="threads-pill__unread">{threadUnread} unread</span>
          {/if}
        </button>
      {/if}
      {#if isFocused}
        <button
          type="button"
          class="clear-focus-pill"
          onclick={onClearFocus}
          title="Clear focus (Esc)"
        >
          <svg
            viewBox="0 0 16 16"
            width="11"
            height="11"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
          Clear focus
        </button>
      {/if}
      {#if layoutStatus}
        <!-- Reports the layout; the toolbar's layout menu changes it. -->
        <span
          class="layout-status"
          title={layoutPristine
            ? "Nodes are positioned by auto-layout"
            : "A node has been moved by hand since the last auto-layout"}
        >
          {layoutStatus}
        </span>
      {/if}
    </div>
  </Panel>
{/if}
