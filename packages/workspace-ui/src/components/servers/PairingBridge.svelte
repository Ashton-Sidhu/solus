<script lang="ts">
  import { Check as CheckIcon, Plus as PlusIcon, X as XIcon } from "@lucide/svelte";
  import HostOperatingSystemIcon from "./HostOperatingSystemIcon.svelte";
  import {
    operatingSystemName,
    pairingStatusLine,
    type BridgeMachine,
    type PairingPhase,
  } from "./lib/pairing-bridge";

  /**
   * This device and the host, joined by a line that shows how far pairing has
   * come (`lib/pairing-bridge.ts`). Motion runs only while something is
   * running, and once when it ends; reduced motion jumps to the end states.
   */
  interface Props {
    phase: PairingPhase;
    device: BridgeMachine;
    /** Null until the host is named. */
    host: BridgeMachine | null;
  }

  let { phase, device, host }: Props = $props();

  const status = $derived(pairingStatusLine(phase, host?.name ?? "the host"));
</script>

<div class="bridge relative pt-2 pb-1" data-phase={phase}>
  <!-- A faint dot field the two machines sit on, faded out at the edges. -->
  <div class="dots pointer-events-none absolute inset-x-0 -top-10 bottom-0" aria-hidden="true"></div>
  <div class="glow pointer-events-none absolute inset-0 opacity-0" aria-hidden="true"></div>

  <div class="relative flex items-start px-4">
    <div class="flex w-24 shrink-0 flex-col items-center gap-2 text-center">
      <span class="tile relative grid size-16 place-items-center overflow-hidden rounded-[1.1875rem] text-(--solus-text-primary)">
        <HostOperatingSystemIcon os={device.os} size={30} />
      </span>
      <span class="max-w-full truncate text-[0.78125rem] font-medium text-(--solus-text-primary)">{device.name}</span>
      <span class="-mt-1 min-h-4 text-xs text-(--solus-text-tertiary)">{operatingSystemName(device.os)}</span>
    </div>

    <div class="wire relative mx-1.5 mt-8 h-px flex-1 bg-(--solus-popover-border)" aria-hidden="true">
      <span class="fill absolute inset-x-0 -top-[0.25px] h-[1.5px]"></span>
      <span class="comet absolute -top-[0.5px] left-0 h-0.5 w-16 rounded-full opacity-0"></span>
      <span class="break absolute top-[-0.5625rem] left-1/2 grid size-[1.125rem] place-items-center rounded-full bg-(--solus-popover-bg) text-destructive">
        <XIcon size={9} strokeWidth={3} />
      </span>
    </div>

    <div class="flex w-24 shrink-0 flex-col items-center gap-2 text-center">
      <span class="relative">
        <span class="ripple pointer-events-none absolute inset-0 rounded-[1.1875rem] opacity-0" aria-hidden="true"></span>
        <span class="tile host-tile relative grid size-16 place-items-center overflow-hidden rounded-[1.1875rem] text-(--solus-text-primary)">
          {#if host}
            {#key host.os}
              <span class="logo grid place-items-center"><HostOperatingSystemIcon os={host.os} size={30} /></span>
            {/key}
          {:else}
            <PlusIcon size={20} class="text-(--solus-text-tertiary)" />
          {/if}
        </span>
        <span class="badge absolute -right-1.5 -bottom-1.5 z-10 grid size-5 place-items-center rounded-full bg-(--solus-text-primary) text-(--solus-popover-bg)" aria-hidden="true">
          <CheckIcon size={10} strokeWidth={3.5} />
        </span>
      </span>
      <span class="max-w-full truncate text-[0.78125rem] font-medium text-(--solus-text-primary)">{host?.name ?? "New host"}</span>
      <span class="-mt-1 min-h-4 text-xs text-(--solus-text-tertiary)">{operatingSystemName(host?.os)}</span>
    </div>

    <p class="status absolute inset-x-28 top-12 truncate text-center text-[0.78125rem] text-(--solus-text-tertiary)" role="status">
      {#key status}<span class="inline-block">{status}</span>{/key}
    </p>
  </div>
</div>

<style>
  .bridge {
    --ease: cubic-bezier(0.22, 1, 0.36, 1);
    --spring: cubic-bezier(0.34, 1.45, 0.64, 1);
    --tile-lift: rgba(50, 38, 24, 0.22);
    --tile-highlight: rgba(255, 255, 255, 0.95);
  }
  :global(.dark) .bridge {
    --tile-lift: rgba(0, 0, 0, 0.55);
    --tile-highlight: rgba(255, 255, 255, 0.12);
  }

  .dots {
    background-image: radial-gradient(color-mix(in srgb, var(--solus-text-primary) 14%, transparent) 0.8px, transparent 0.8px);
    background-size: 12px 12px;
    mask: radial-gradient(60% 70% at 50% 55%, #000, transparent);
  }
  .glow {
    background: radial-gradient(30% 60% at 78% 40%, color-mix(in srgb, var(--solus-accent) 22%, transparent), transparent 70%);
  }

  .tile {
    background: linear-gradient(180deg, var(--solus-popover-bg), color-mix(in srgb, var(--solus-popover-bg) 93%, var(--solus-text-primary)));
    border: 1px solid var(--solus-popover-border);
    box-shadow:
      inset 0 1px 0 var(--tile-highlight),
      0 1px 1px rgba(0, 0, 0, 0.04),
      0 8px 16px -8px var(--tile-lift),
      0 22px 36px -22px var(--tile-lift);
    transition: border-color 0.5s var(--ease) 0.35s;
  }
  /* Light passing over the host: while it is looked up, and once when paired. */
  .host-tile::after {
    content: "";
    position: absolute;
    inset: -40%;
    background: linear-gradient(105deg, transparent 40%, var(--tile-highlight) 50%, transparent 60%);
    transform: translateX(-80%);
    opacity: 0;
    pointer-events: none;
  }
  .logo { animation: logo-in 0.5s var(--spring) both; }
  .badge { transform: scale(0); box-shadow: 0 0 0 2.5px var(--solus-popover-bg), 0 3px 8px -2px var(--tile-lift); }
  .ripple { box-shadow: 0 0 0 1px var(--solus-accent); }
  .fill { transform: scaleX(0); transform-origin: left; background: var(--solus-accent); transition: transform 0.55s var(--ease); }
  .comet {
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--solus-accent) 80%, transparent) 75%, #fff);
    filter: drop-shadow(0 0 4px color-mix(in srgb, var(--solus-accent) 70%, transparent));
  }
  .break {
    transform: translateX(-50%) scale(0);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--destructive) 40%, transparent);
    transition: transform 0.35s var(--spring) 0.25s;
  }
  .status span { animation: status-in 0.4s var(--ease) both; }

  [data-phase="looking"] .host-tile::after { opacity: 1; animation: glint 1.1s var(--ease) infinite; }
  [data-phase="pairing"] .comet { animation: comet 1.5s cubic-bezier(0.65, 0, 0.35, 1) infinite; }

  [data-phase="paired"] .fill { transform: scaleX(1); }
  [data-phase="paired"] .host-tile { border-color: color-mix(in srgb, var(--solus-accent) 45%, var(--solus-popover-border)); }
  [data-phase="paired"] .host-tile::after { opacity: 1; animation: glint 0.9s var(--ease) 0.4s both; }
  [data-phase="paired"] .ripple { animation: ripple 1s var(--ease) 0.45s both; }
  [data-phase="paired"] .badge { animation: pop 0.5s var(--spring) 0.6s both; }
  [data-phase="paired"] .glow { animation: bloom 1.8s var(--ease) 0.45s both; }
  [data-phase="paired"] .status { color: var(--solus-text-primary); }

  [data-phase="error"] .fill { background: var(--destructive); transform: scaleX(0.5); transition-duration: 0.35s; }
  [data-phase="error"] .break { transform: translateX(-50%) scale(1); }
  [data-phase="error"] .host-tile { animation: shake 0.45s var(--ease) 0.25s; }
  [data-phase="error"] .status { color: var(--destructive); }

  @keyframes glint { to { transform: translateX(80%); } }
  @keyframes comet {
    0% { left: -4rem; opacity: 0; }
    20%, 80% { opacity: 1; }
    100% { left: 100%; opacity: 0; }
  }
  @keyframes ripple { from { opacity: 0.55; transform: scale(1); } to { opacity: 0; transform: scale(1.5); } }
  @keyframes pop { to { transform: scale(1); } }
  @keyframes bloom { 0% { opacity: 0; } 30% { opacity: 1; } 100% { opacity: 0.4; } }
  @keyframes shake { 20% { transform: translateX(-3px); } 45% { transform: translateX(3px); } 70% { transform: translateX(-1.5px); } }
  @keyframes logo-in { from { opacity: 0; transform: scale(0.6); filter: blur(4px); } }
  @keyframes status-in { from { opacity: 0; transform: translateY(3px); } }

  @media (prefers-reduced-motion: reduce) {
    .bridge *, .bridge *::after {
      animation-duration: 1ms !important;
      animation-delay: 0s !important;
      animation-iteration-count: 1 !important;
      transition-duration: 1ms !important;
      transition-delay: 0s !important;
    }
    [data-phase="looking"] .host-tile::after, [data-phase="pairing"] .comet { animation: none; opacity: 0; }
  }
</style>
