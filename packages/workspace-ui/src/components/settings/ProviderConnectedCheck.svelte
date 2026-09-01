<script lang="ts">
  /** A live provider account, marked with a check beside its name.
   *
   *  Only the connected state is drawn. Every row already states its own
   *  situation in words — the account it is connected as, the pitch for
   *  connecting, "Checking…", or "Unavailable in this build of Solus" — so a
   *  second control repeating that on every row is chrome nobody reads. The
   *  check is the one thing words scan slowly for: which of these are live.
   *
   *  It is a shape, not a colour, so it survives both themes and does not rely
   *  on a user telling green from grey. */
  import { CircleCheck as CircleCheckIcon } from "@lucide/svelte";

  interface Props {
    connected: boolean;
    /** The provider, for a screen reader that reads the check out of row context. */
    provider: string;
  }

  let { connected, provider }: Props = $props();
</script>

{#if connected}
  <CircleCheckIcon
    size={13}
    role="img"
    aria-label="{provider} is connected"
    class="ml-1.5 inline-block shrink-0 align-[-0.15em] text-(--solus-status-complete)"
  />
{/if}
