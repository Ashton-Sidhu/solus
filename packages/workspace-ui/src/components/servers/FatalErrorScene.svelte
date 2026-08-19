<script lang="ts">
  import { serversStore } from "../../contexts";
  import CopyButton from "../ui/CopyButton.svelte";

  /**
   * Where a render crash lands, so it is never a blank window. Deliberately
   * still — a spinner here would animate exactly like an app that is still
   * working. Boot-time connection failures have their own scene in
   * `boot-scene.ts`, which runs before Svelte exists.
   */
  let { error }: { error: unknown } = $props();

  const host = $derived(serversStore.activeServer);
  const raw = $derived(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
</script>

<div
  data-solus-ui
  class="text-sm fixed inset-0 z-[10020] grid place-items-center bg-(--solus-edge-bg) font-secondary"
  role="alert"
>
  <!-- Same mark and size as the boot shell, so a crash lands on a surface the
       user already recognises. Centred as a whole group: nothing was on screen
       a frame earlier to stay continuous with. -->
  <!-- Wide enough for a stack trace to breathe; prose stays at a readable
       measure inside it, only the trace uses the full width. -->
  <div class="flex w-[min(40rem,calc(100vw-3rem))] flex-col items-center">
    <svg
      class="block h-21 w-21 opacity-35"
      viewBox="0 0 1024 1024"
      aria-hidden="true"
    >
      <circle cx="512" cy="512" r="180" fill="var(--solus-accent)" />
      <g
        fill="none"
        stroke="var(--solus-accent)"
        stroke-width="60"
        stroke-linecap="round"
        opacity="0.55"
      >
        <path d="M512,212 A300,300 0 0 1 812,512" />
        <path d="M764,716 A300,300 0 0 1 416,800" />
        <path d="M260,716 A300,300 0 0 1 212,416" />
      </g>
    </svg>

    <div
      class="mt-7 max-w-88 text-center  text-(--solus-text-primary)"
    >
      Solus hit an unexpected error
    </div>
    <p
      class="mt-1.5 max-w-88 text-center  leading-relaxed text-(--solus-text-tertiary)"
    >
      The interface stopped rendering. Your sessions live on the host and are not
      affected.
    </p>

    <div class="mt-4.5 flex gap-2">
      <button
        type="button"
        class="rounded-lg bg-(--solus-accent) px-3.5 py-1.5  text-white transition-[filter] hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
        onclick={() => location.reload()}
      >
        Reload Solus
      </button>
      {#if host && !host.local}
        <button
          type="button"
          class="rounded-lg border border-(--solus-input-border) px-3.5 py-1.5  text-(--solus-text-secondary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
          onclick={() => serversStore.useLocalHost()}
        >
          Use this Mac
        </button>
      {/if}
    </div>

    <details
      class="group mt-4 w-full overflow-hidden rounded-lg border border-(--solus-menu-hairline) bg-(--solus-surface-hover)"
    >
      <summary
        class="flex cursor-pointer list-none items-center justify-between gap-3 border-(--solus-menu-hairline) py-1.5 pr-2 pl-3  text-(--solus-text-secondary) group-open:border-b"
      >
        Technical details
        <!-- Inside <summary>, a click would toggle the disclosure shut on the
             way to the clipboard. Capture-phase so CopyButton's own handler
             still runs; the interactive element is the button it wraps. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <span onclickcapture={(event) => event.preventDefault()}>
          <CopyButton text={raw} title="Copy error details" />
        </span>
      </summary>
      <!-- The trace is the one thing here a user may need to read closely or
           hand to someone else, so it gets body-text contrast, not footnote. -->
      <pre
        class="m-0 max-h-72 overflow-auto px-3 py-2.5 text-xs leading-relaxed break-words whitespace-pre-wrap text-(--solus-text-secondary) select-text">{raw}</pre>
    </details>
  </div>
</div>
