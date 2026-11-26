<script lang="ts">
  /** A QR code of a link, drawn as PairCodePanel draws its pairing link. Nothing shows when the value is too long for a QR code. */
  import { qrDrawing } from "../lib/outside-apps-share";

  interface Props {
    value: string;
    label: string;
  }

  let { value, label }: Props = $props();

  const drawing = $derived(qrDrawing(value));
</script>

{#if drawing}
  <svg
    class="block size-32 shrink-0 rounded-lg bg-white p-1.5 text-black shadow-[0_0_0_1px_var(--solus-container-border)]"
    viewBox={drawing.viewBox}
    role="img"
    aria-label={label}
    shape-rendering="crispEdges"
    focusable="false"
  >
    <path d={drawing.path} fill="currentColor" />
  </svg>
{/if}
