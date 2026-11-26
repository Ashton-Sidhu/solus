<script lang="ts">
  import { Ban, CircleCheck, CircleDashed, RefreshCw, ShieldX, WifiOff } from "@lucide/svelte";
  import type { RouteState } from "@solus/client-core/host-route-control";
  import * as Tooltip from "../ui/tooltip";

  /** A route's state as one icon: the word is in its tooltip and accessible name. */
  interface Props {
    state: RouteState;
    /** The words of the state, as `routeStateText` gives them. */
    label: string;
    size?: number;
  }

  let { state, label, size = 14 }: Props = $props();
</script>

<Tooltip.Root delayDuration={150}>
  <Tooltip.Trigger>
    {#snippet child({ props })}
      <span
        {...props}
        role="img"
        aria-label={label}
        class="inline-flex shrink-0 {state === 'in-use'
          ? 'text-(--success)'
          : state === 'refused' || state === 'different-server'
            ? 'text-(--solus-status-error)'
            : state === 'connecting' || state === 'not-answering'
              ? 'text-(--warning)'
              : 'text-(--solus-text-tertiary)'}"
      >
        {#if state === "in-use"}<CircleCheck {size} />
        {:else if state === "connecting"}<RefreshCw {size} />
        {:else if state === "refused" || state === "different-server"}<ShieldX {size} />
        {:else if state === "not-answering"}<WifiOff {size} />
        {:else if state === "blocked"}<Ban {size} />
        {:else}<CircleDashed {size} />{/if}
      </span>
    {/snippet}
  </Tooltip.Trigger>
  <Tooltip.Content value={label} />
</Tooltip.Root>
