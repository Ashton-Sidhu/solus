<script lang="ts">
  import {
    CircleArrowUp,
    CircleCheck,
    KeyRound,
    LoaderCircle,
    Moon,
    Power,
    RefreshCw,
    WifiOff,
  } from "@lucide/svelte";
  import type { FleetState } from "./lib/fleet-model";

  /** A host's state as one icon (docs/plans/host-fleet.md D3): the word is in the
   *  tooltip and the accessible name, never on the page, and there is no dot. */
  interface Props {
    state: FleetState | "online" | "update" | "signin";
    /** The sessions running, beside the running icon; or any count a summary gives. */
    count?: number;
    size?: number;
    /** A more precise word for the state, such as "Needs pairing" for a host that is unreachable because it refuses this device. */
    label?: string;
  }

  let { state, count, size = 13, label: preciseLabel }: Props = $props();

  const word = $derived(
    {
      running: "Sessions running",
      idle: "Idle",
      online: "Online",
      checking: "Checking",
      starting: "Starting",
      reconnecting: "Reconnecting",
      unreachable: "Unreachable",
      stopped: "Stopped",
      update: "Update available",
      signin: "Needs a sign-in",
    }[state],
  );
  const label = $derived((preciseLabel ?? word) + (count !== undefined ? `: ${count}` : ""));
</script>

<span
  role="img"
  aria-label={label}
  title={label}
  class="inline-flex shrink-0 items-center gap-1 text-chrome-dense font-medium tabular-nums {state === 'running' || state === 'update'
    ? 'text-(--solus-status-running)'
    : state === 'stopped'
      ? 'text-foreground'
      : state === 'idle' || state === 'online'
        ? 'text-(--success)'
        : state === 'unreachable'
          ? 'text-(--solus-status-error)'
          : 'text-(--warning)'}"
>
  {#if state === "running"}<LoaderCircle {size} class="animate-spin motion-reduce:animate-none" />
  {:else if state === "idle"}<Moon {size} />
  {:else if state === "online"}<CircleCheck {size} />
  {:else if state === "unreachable"}<WifiOff {size} />
  {:else if state === "stopped"}<Power {size} />
  {:else if state === "update"}<CircleArrowUp {size} />
  {:else if state === "signin"}<KeyRound {size} />
  {:else}<RefreshCw {size} />{/if}
  {#if count !== undefined}{count}{/if}
</span>
