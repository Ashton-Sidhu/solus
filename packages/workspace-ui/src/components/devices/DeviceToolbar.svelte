<script lang="ts">
  import { Box, Camera, Hand, House, Keyboard, LayoutGrid, Play, Power, Rotate3d, RotateCwSquare, SlidersHorizontal, Smartphone, Undo2 } from "@lucide/svelte";
  import type { DeviceButton, DeviceControlState, DevicePlatform } from "@solus/contracts/device-types";
  import { deviceSupportsButton } from "@solus/contracts/device-types";
  import type { Snippet } from "svelte";
  import * as TooltipUI from "../ui/tooltip";
  import { controlLabel, liveStateLabel, type DeviceLiveState } from "./lib/device-pane";
  import type { DevicePresentation } from "./lib/device-view-state.svelte";

  /**
   * A vertical pill that floats on the stage beside the device, like the
   * side bar of a simulator: hardware buttons, then who controls the device,
   * then the actions on the device, then power. The tab names the device, so
   * the pill holds only icons. Take control, Release and Resume agent are
   * separate, explicit actions (plan 016, S01).
   */

  interface Props {
    platform: DevicePlatform;
    name: string;
    version: string;
    /** Set when other sessions show this device too. */
    sharedNote: string;
    liveState: DeviceLiveState;
    control: DeviceControlState | null;
    holdsControl: boolean;
    toolsOpen: boolean;
    busy: boolean;
    onTakeControl: () => void;
    onRelease: () => void;
    onResumeAgent: () => void;
    onButton: (button: DeviceButton) => void;
    onRotate: () => void;
    onScreenshot: () => void;
    onKeyboard: () => void;
    onToggleTools: () => void;
    onShutdown: () => void;
    presentation: DevicePresentation;
    /** This client cannot draw 3D (no WebGL); the flat view is shown. */
    phoneUnavailable: boolean;
    onPresentation: (presentation: DevicePresentation) => void;
    onResetView: () => void;
    /** Runs a build on this device, when one fits it. */
    runBuild?: Snippet;
  }

  let props: Props = $props();

  const buttons = $derived(
    ([
      { button: "home", label: "Home", icon: House },
      { button: "back", label: "Back", icon: Undo2 },
      { button: "appSwitcher", label: props.platform === "ios" ? "App switcher" : "Recents", icon: LayoutGrid },
    ] as const).filter((entry) => deviceSupportsButton(props.platform, entry.button)),
  );
  const live = $derived(props.liveState === "live");
  const deviceLabel = $derived([props.name, props.version, props.sharedNote].filter(Boolean).join(", "));
</script>

{#snippet tool(label: string, onclick: () => void, Icon: typeof House, options: { pressed?: boolean; disabled?: boolean } = {})}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: trigger })}
        <button
          {...trigger}
          type="button"
          class="flex size-8 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) disabled:pointer-events-none disabled:opacity-30 {options.pressed
            ? 'bg-[color-mix(in_oklch,var(--primary)_14%,transparent)] text-[var(--primary)] hover:bg-[color-mix(in_oklch,var(--primary)_14%,transparent)] hover:text-[var(--primary)]'
            : ''}"
          aria-label={label}
          aria-pressed={options.pressed}
          disabled={options.disabled ?? !live}
          {onclick}
        >
          <Icon class="size-4" />
        </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content side="left" value={label} />
  </TooltipUI.Root>
{/snippet}

{#snippet divider()}
  <div class="my-1 h-px w-5 shrink-0 bg-[var(--hairline-strong)]"></div>
{/snippet}

<div
  class="relative flex max-h-full shrink-0 flex-col items-center gap-1 overflow-y-auto rounded-full bg-[var(--card)] p-1 shadow-[shadow:0_0_0_0.5px_var(--hairline-strong),0_0.5rem_1.5rem_-0.75rem_rgba(0,0,0,0.25)] no-scrollbar"
  role="toolbar"
  aria-orientation="vertical"
  aria-label={deviceLabel}
  data-testid="device-toolbar"
>
  <!-- The tab shows a device that is not live with a dot; the state is
       announced here too. -->
  {#if !live}<span class="sr-only" role="status">{liveStateLabel(props.liveState)}</span>{/if}

  {#each buttons as entry (entry.button)}
    {@render tool(entry.label, () => props.onButton(entry.button), entry.icon)}
  {/each}
  {#if props.platform === "ios"}
    {@render tool("Rotate", props.onRotate, RotateCwSquare)}
  {/if}

  {#if props.control || (props.runBuild && live)}
    {@render divider()}
  {/if}

  {#if props.control}
    {@const control = props.control}
    {@const label = controlLabel(control, props.holdsControl)}
    <!-- The hand is the action; the full state is its tooltip and is announced. -->
    <span class="sr-only" role="status" aria-live="polite">{label}</span>
    {@render tool(
      props.holdsControl ? `Release control. ${label}` : `Take control. ${label}`,
      props.holdsControl ? props.onRelease : props.onTakeControl,
      Hand,
      { pressed: props.holdsControl, disabled: props.busy },
    )}
    {#if control.agentPaused}
      {@render tool("Resume agent. Agent actions are paused", props.onResumeAgent, Play, { disabled: false })}
    {/if}
  {/if}

  {#if props.runBuild && live}{@render props.runBuild()}{/if}

  {@render divider()}

  {@render tool(props.phoneUnavailable ? "3D view is not available in this browser" : "3D view", () => props.onPresentation("phone"), Box, { pressed: props.presentation === "phone" && !props.phoneUnavailable, disabled: !live || props.phoneUnavailable })}
  {@render tool("Flat view", () => props.onPresentation("flat"), Smartphone, { pressed: props.presentation === "flat" || props.phoneUnavailable })}
  {#if props.presentation === "phone" && !props.phoneUnavailable}
    {@render tool("Restore 3D view", props.onResetView, Rotate3d)}
  {/if}

  {@render divider()}

  {@render tool("Type on the device", props.onKeyboard, Keyboard)}
  {@render tool("Download screenshot", props.onScreenshot, Camera)}
  {@render tool("Device tools", props.onToggleTools, SlidersHorizontal, { pressed: props.toolsOpen })}

  {@render divider()}

  {@render tool("Power off device", props.onShutdown, Power, { disabled: props.liveState === "offline" || props.liveState === "stopped" })}
</div>
