<script lang="ts">
  import { serversStore } from "../../contexts";

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
  class="fixed inset-0 z-[10020] grid place-items-center bg-(--solus-edge-bg) font-secondary"
  role="alert"
>
  <!-- Mark pinned to the same centre and size as the boot shell, so a crash
       lands on a surface the user already recognises. -->
  <div class="relative">
    <svg
      class="block h-18 w-18 opacity-35"
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
      class="absolute left-1/2 top-[calc(100%+1.5rem)] flex w-72 -translate-x-1/2 flex-col items-center"
    >
      <div class="text-center text-[0.9375rem] text-(--solus-text-primary)">
        Solus hit an unexpected error
      </div>
      <p
        class="mt-1.5 text-center text-xs leading-relaxed text-(--solus-text-tertiary)"
      >
        The interface stopped rendering. Your sessions live on the host and are
        not affected.
      </p>

      <div class="mt-4 flex gap-2">
        <button
          type="button"
          class="rounded-md bg-(--solus-accent) px-2.5 py-1 text-[0.71875rem] text-white transition-[filter] hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
          onclick={() => location.reload()}
        >
          Reload Solus
        </button>
        {#if host && !host.local}
          <button
            type="button"
            class="rounded-md border border-(--solus-input-border) px-2.5 py-1 text-[0.71875rem] text-(--solus-text-secondary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
            onclick={() => serversStore.useLocalHost()}
          >
            Use this Mac
          </button>
        {/if}
      </div>

      <details
        class="mt-3.5 w-full overflow-hidden rounded-lg border border-(--solus-menu-hairline) bg-(--solus-surface-hover)"
      >
        <summary
          class="cursor-pointer list-none px-2.5 py-1.5 text-[0.6875rem] text-(--solus-text-tertiary)"
        >
          Technical details
        </summary>
        <pre
          class="m-0 max-h-40 overflow-auto px-2.5 pb-2 font-mono text-[0.625rem] leading-relaxed break-words whitespace-pre-wrap text-(--solus-text-tertiary) select-text">{raw}</pre>
      </details>
    </div>
  </div>
</div>
