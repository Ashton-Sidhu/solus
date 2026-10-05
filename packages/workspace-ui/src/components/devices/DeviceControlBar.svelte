<script lang="ts">
  import { Camera, Hand, House, Keyboard, LayoutGrid, Power, RotateCw, Undo2, Play, SlidersHorizontal } from "@lucide/svelte";
  import type { DeviceButton, DeviceControlState, DevicePlatform } from "@solus/contracts/device-types";
  import { deviceSupportsButton } from "@solus/contracts/device-types";
  import { Button } from "../ui/button";
  import { controlLabel } from "./lib/device-pane";

  /**
   * The row under the device screen: who controls it, the hardware buttons,
   * and the pane's device actions. Take control, Release and Resume agent
   * are separate, explicit actions (plan 016, S01).
   */

  interface Props {
    platform: DevicePlatform;
    control: DeviceControlState;
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
  }

  let props: Props = $props();

  const buttons = $derived(
    ([
      { button: "home", label: "Home", icon: House },
      { button: "back", label: "Back", icon: Undo2 },
      { button: "appSwitcher", label: props.platform === "ios" ? "App switcher" : "Recents", icon: LayoutGrid },
    ] as const).filter((entry) => deviceSupportsButton(props.platform, entry.button)),
  );
</script>

<div class="flex flex-col gap-2 border-t border-border px-3 py-2" data-testid="device-control-bar">
  <div class="flex min-w-0 items-center gap-2">
    <span class="min-w-0 flex-1 truncate text-chrome-dense text-muted-foreground" role="status" aria-live="polite">
      {controlLabel(props.control, props.holdsControl)}
    </span>
    {#if props.holdsControl}
      <Button size="xs" variant="ghost" onclick={props.onRelease}>Release</Button>
    {:else if !props.control.pendingTakeover}
      <Button size="xs" variant="outline" onclick={props.onTakeControl} disabled={props.busy}>
        <Hand />Take control
      </Button>
    {/if}
    {#if props.control.agentPaused}
      <Button size="xs" variant="outline" onclick={props.onResumeAgent}>
        <Play />Resume agent
      </Button>
    {/if}
  </div>
  <div class="flex flex-wrap items-center gap-1">
    {#each buttons as entry (entry.button)}
      <Button size="icon-sm" variant="ghost" aria-label={entry.label} title={entry.label} onclick={() => props.onButton(entry.button)}>
        <entry.icon />
      </Button>
    {/each}
    {#if props.platform === "ios"}
      <Button size="icon-sm" variant="ghost" aria-label="Rotate" title="Rotate" onclick={props.onRotate}><RotateCw /></Button>
    {/if}
    <Button size="icon-sm" variant="ghost" aria-label="Type on the device" title="Type on the device" onclick={props.onKeyboard}><Keyboard /></Button>
    <Button size="icon-sm" variant="ghost" aria-label="Download screenshot" title="Download screenshot" onclick={props.onScreenshot}><Camera /></Button>
    <Button size="icon-sm" variant={props.toolsOpen ? "secondary" : "ghost"} aria-label="Device tools" aria-pressed={props.toolsOpen} title="Device tools" onclick={props.onToggleTools}><SlidersHorizontal /></Button>
    <span class="flex-1"></span>
    <Button size="icon-sm" variant="ghost" aria-label="Power off device" title="Power off device" onclick={props.onShutdown}><Power /></Button>
  </div>
</div>
