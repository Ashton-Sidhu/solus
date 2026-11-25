<script lang="ts">
  import { Globe, Link2, Monitor, ShieldCheck, Terminal } from "@lucide/svelte";
  import type { RouteKind } from "@solus/contracts/host-routes";

  /** The mark of a route kind (docs/plans/host-fleet.md D13). Tailscale has its own dot mark; the others are plain glyphs. */
  interface Props {
    kind: RouteKind;
    size?: number;
  }

  let { kind, size = 12 }: Props = $props();
</script>

{#if kind === "tailnet"}
  <!-- The Tailscale mark: nine dots, the middle row and the lower middle full. -->
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    {#each [[4, 4, 0.3], [12, 4, 0.3], [20, 4, 0.3], [4, 12, 1], [12, 12, 1], [20, 12, 1], [4, 20, 0.3], [12, 20, 1], [20, 20, 0.3]] as [cx, cy, opacity] (`${cx}:${cy}`)}
      <circle {cx} {cy} r="2.75" fill-opacity={opacity} />
    {/each}
  </svg>
{:else if kind === "lan"}<Monitor {size} aria-hidden="true" />
{:else if kind === "vpn"}<ShieldCheck {size} aria-hidden="true" />
{:else if kind === "public"}<Globe {size} aria-hidden="true" />
{:else if kind === "forwarded"}<Terminal {size} aria-hidden="true" />
{:else}<Link2 {size} aria-hidden="true" />{/if}
