<script lang="ts">
  import { ChevronDown, Circle, Square } from "@lucide/svelte";
  import type { BrowserEvidenceOptions } from "@solus/contracts/browser-types";
  import type { Task } from "@solus/contracts/task-types";
  import { getWorkspaceContext, hostCapabilitiesStore } from "../../contexts";
  import {
    browserStore,
    type BrowserPageEntry,
  } from "../../contexts/browser/browser.store.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import * as Popover from "../ui/popover";
  import * as TooltipUI from "../ui/tooltip";
  import { evidenceChoices } from "./lib/evidence-menu";
  import { recordControl, recordingElapsed } from "./lib/recording";
  import {
    focusLeadingComposer,
    startPageRecording,
    stopPageRecording,
    togglePageRecording,
  } from "./lib/recording-actions";

  /**
   * Record the page, then stop and keep the video.
   *
   * The recording runs on the host, so this control only states the page's
   * `recording` and asks the host to change it. A recording an agent started
   * shows here too, and the user can stop it. Stop puts the video on the
   * composer; the menu beside Stop also files it on a task or pull request,
   * as the capture menu does for a still.
   */

  interface Props {
    entry: BrowserPageEntry;
    paneId: string;
    surfaceVisible: boolean;
    options: BrowserEvidenceOptions | null;
    tasks: Task[];
    cwd: string | undefined;
    /** Ask the host where this page could be filed. */
    onOpenDestinations: () => void;
  }

  let {
    entry,
    paneId,
    surfaceVisible,
    options,
    tasks,
    cwd,
    onOpenDestinations,
  }: Props = $props();

  const session = getWorkspaceContext();
  const focusComposer = () => focusLeadingComposer(session.router);
  const pageKey = $derived(
    browserStore.keyOf(entry.serverId, entry.page.browserPageId),
  );
  const control = $derived(
    recordControl({
      page: entry.page,
      canRecord: hostCapabilitiesStore.for(entry.serverId)?.browserRecording,
      request: browserStore.recordingRequest(pageKey),
    }),
  );
  const shortcut = comboHint("browser-pane.toggle-recording");
  const destinations = $derived(
    evidenceChoices(options ?? {}, tasks, cwd).filter(
      (choice) => choice.target,
    ),
  );

  let menuOpen = $state(false);
  let menuTrigger = $state<HTMLButtonElement | null>(null);

  // The running time. It ticks once a second, and only while a recording
  // runs and the pane is on screen.
  let now = $state(Date.now());
  const isRecording = $derived(control.kind === "recording");
  const elapsed = $derived(
    control.kind === "recording"
      ? recordingElapsed(control.startedAt, now)
      : "",
  );
  $effect(() => {
    if (!isRecording || !surfaceVisible) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  // `⌥R` belongs to the browser pane that has focus, not to every mounted one.
  const hasFocus = () =>
    surfaceVisible && session.router.focusedPaneId === paneId;
  useScope("browser-pane", { active: hasFocus });
  useKeybinding(
    "browser-pane.toggle-recording",
    () => togglePageRecording(entry, focusComposer),
    { enabled: hasFocus },
  );
</script>

{#if control.kind === "recording"}
  <div
    class="flex h-6.5 shrink-0 items-center gap-1.5 rounded-full bg-[color-mix(in_oklch,var(--failure)_12%,transparent)] pr-0.5 pl-2"
    role="status"
    aria-label="{control.label}, {elapsed}"
  >
    <span class="size-2 shrink-0 rounded-full bg-[var(--failure)]"></span>
    <span
      class="text-workspace-chrome shrink-0 text-(--solus-text-secondary) @max-[34rem]/toolbar:hidden"
      >{control.label}</span
    >
    <span
      class="text-workspace-chrome shrink-0 text-(--solus-text-primary) tabular-nums"
      >{elapsed}</span
    >
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="relative flex size-5.5 shrink-0 items-center justify-center rounded-full text-[var(--failure)] transition-colors hover:bg-[color-mix(in_oklch,var(--failure)_18%,transparent)] disabled:pointer-events-none disabled:opacity-40 pointer-coarse:before:absolute pointer-coarse:before:top-1/2 pointer-coarse:before:left-1/2 pointer-coarse:before:size-11 pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']"
            disabled={control.isStopping}
            aria-label="Stop recording and attach it to the message"
            onclick={() => stopPageRecording(entry, undefined, focusComposer)}
          >
            <Square class="size-3 fill-current" />
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content
        side="bottom"
        value={control.isStopping
          ? "Saving the recording"
          : `Stop and attach to the message (${shortcut})`}
      />
    </TooltipUI.Root>
    <button
      bind:this={menuTrigger}
      type="button"
      class="relative flex size-5.5 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) disabled:pointer-events-none disabled:opacity-40 pointer-coarse:before:absolute pointer-coarse:before:top-1/2 pointer-coarse:before:left-1/2 pointer-coarse:before:size-11 pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']"
      disabled={control.isStopping}
      aria-label="Stop and file the recording"
      aria-haspopup="dialog"
      aria-expanded={menuOpen}
      onclick={() => {
        // Destinations go stale, as they do for a capture: ask on each open.
        if (!menuOpen) onOpenDestinations();
        menuOpen = !menuOpen;
      }}
    >
      <ChevronDown class="size-3" />
    </button>
  </div>

  <Popover.Root bind:open={menuOpen}>
    <Popover.Content
      customAnchor={menuTrigger}
      side="bottom"
      align="end"
      sideOffset={6}
      class="max-h-[calc(100vh-8rem)] w-[min(18.5rem,calc(100vw-2rem))] overflow-y-auto p-1.5"
      aria-label="Stop and file the recording"
    >
      <div class="text-workspace-chrome">
        <div
          class="px-2 pt-1 pb-1.5 font-medium tracking-widest text-(--solus-text-tertiary) uppercase"
        >
          Stop and file on
        </div>
        {#each destinations as choice (choice.id)}
          {@const Icon = choice.icon}
          <button
            type="button"
            class="flex h-8 w-full items-center gap-2.5 overflow-hidden rounded-md px-2 text-left transition-colors hover:bg-[var(--wash-2)]"
            onclick={() => {
              menuOpen = false;
              stopPageRecording(entry, choice.target, focusComposer);
            }}
          >
            <Icon class="size-3.5 shrink-0 text-(--solus-text-tertiary)" />
            <span class="min-w-0 flex-1 truncate text-(--solus-text-primary)"
              >{choice.label}</span
            >
            {#if choice.detail}
              <span
                class="max-w-[45%] shrink-0 truncate text-(--solus-text-tertiary)"
                >{choice.detail}</span
              >
            {/if}
          </button>
        {:else}
          <p class="px-2 pt-1.5 pb-1 text-(--solus-text-tertiary)">
            No open task or pull request for this page. Stop attaches the
            recording to the message.
          </p>
        {/each}
      </div>
    </Popover.Content>
  </Popover.Root>
{:else}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <!-- The span keeps the tooltip reachable while the button is disabled,
             so the reason is always one hover away. -->
        <span {...props} class="inline-flex shrink-0">
          <button
            type="button"
            class="relative flex size-6.5 shrink-0 items-center justify-center rounded-full text-(--solus-text-secondary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) disabled:pointer-events-none disabled:opacity-30 pointer-coarse:before:absolute pointer-coarse:before:top-1/2 pointer-coarse:before:left-1/2 pointer-coarse:before:size-11 pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']"
            disabled={control.disabledReason !== null}
            aria-label="Record this page"
            onclick={() => startPageRecording(entry)}
          >
            <Circle class="size-3.5" />
          </button>
        </span>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content
      side="bottom"
      value={control.disabledReason ?? `Record this page (${shortcut})`}
    />
  </TooltipUI.Root>
{/if}
