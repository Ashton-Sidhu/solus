<script lang="ts">
  import type { Snippet } from "svelte";
  import type { FleetTone } from "./lib/fleet-model";

  /** A host's mark inside a ring that fills with its CPU: green while healthy,
   *  amber past 80% or while it reconnects, red when it is unreachable. */
  interface Props {
    cpu: number | null;
    tone: FleetTone;
    size?: number;
    children: Snippet;
  }

  let { cpu, tone, size = 30, children }: Props = $props();

  const radius = $derived(size / 2 - 2);
  const circumference = $derived(2 * Math.PI * radius);
  const stroke = $derived(
    cpu !== null && cpu >= 80 ? "var(--warning)"
      : tone === "ok" ? "var(--success)"
        : tone === "warn" ? "var(--warning)"
          : tone === "bad" ? "var(--solus-status-error)"
            : "var(--solus-status-idle)",
  );
</script>

<span class="relative grid shrink-0 place-items-center text-muted-foreground" style:width="{size}px" style:height="{size}px">
  <svg width={size} height={size} class="absolute inset-0 -rotate-90" aria-hidden="true">
    <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke-width="2" style:stroke="var(--hairline-strong)" />
    {#if cpu !== null}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke-width="2"
        stroke-linecap="round"
        stroke-dasharray="{(cpu / 100) * circumference} {circumference}"
        style:stroke
        class="transition-[stroke-dasharray] duration-1000 ease-out motion-reduce:transition-none"
      />
    {/if}
  </svg>
  {@render children()}
</span>
