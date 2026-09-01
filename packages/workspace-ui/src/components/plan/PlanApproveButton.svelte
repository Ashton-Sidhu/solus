<script lang="ts">
  import {
    Check as CheckIcon,
    ChevronDown as CaretDownIcon,
    GitFork as GitForkIcon,
    Bot as RobotIcon,
  } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import Kbd from "../ui/Kbd.svelte";
  import { runtime } from "../../contexts";

  // Primary approve split button: the main segment approves in auto mode
  // (today's primary action); the caret offers ask-each-step and the worktree
  // execution options. Model/effort knowledge lives in the composer's
  // SessionChip — the host passes the picker selection into
  // approvePlanWithModel itself.
  interface Props {
    useWorktree?: boolean;
    startNewSession?: boolean;
    showNewSessionOption?: boolean;
    showWorktreeToggle?: boolean;
    onApprove: (mode: "ask" | "auto") => void;
  }

  let {
    useWorktree = $bindable(false),
    startNewSession = $bindable(true),
    showNewSessionOption = true,
    showWorktreeToggle = false,
    onApprove,
  }: Props = $props();

  let open = $state(false);
  // Keyboard hints, not layout: only name ⌥ chords where there is an ⌥ to
  // press. A tablet with a keyboard should read them; a phone in a wide
  // landscape window should not.
  const hasKeyboard = $derived(runtime.hasKeyboardPointer);
</script>

<!-- Split button: one accent slab, seam drawn by the caret's ::before rule.
     The desktop height tracks the embedded composer's compact control row. -->
<div class="inline-flex h-7 overflow-hidden rounded-md max-md:h-9 max-md:flex-1">
  <button
    type="button"
    onclick={() => onApprove("auto")}
    data-testid="plan-action-yes-auto"
    class="flex h-7 cursor-pointer items-center gap-1 rounded-l-md border border-r-0 border-transparent bg-(--solus-accent) px-2 text-xs font-medium text-white shadow-[0_0.0625rem_0.125rem_rgba(217,119,87,0.25),inset_0_0_0_0.0625rem_rgba(255,255,255,0.10)] transition-[background-color,box-shadow,transform] duration-(--duration-quick) ease-(--ease-premium) hover:bg-(--solus-send-hover) hover:shadow-[0_0.125rem_0.5rem_rgba(217,119,87,0.32),inset_0_0_0_0.0625rem_rgba(255,255,255,0.12)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium) motion-reduce:transition-none motion-reduce:active:scale-100 max-md:h-9 max-md:flex-1 max-md:justify-center max-md:pr-1 max-md:text-sm"
  >
    <CheckIcon size={13} />
    Approve
    {#if hasKeyboard}<span
        class="ml-0.5 text-xs tabular-nums opacity-45"
        >⌥A</span
      >{/if}
  </button>
  <DropdownMenu.Root bind:open>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="relative flex h-7 w-5.5 cursor-pointer items-center justify-center rounded-r-md border border-l-0 border-transparent bg-(--solus-accent) text-white shadow-[0_0.0625rem_0.125rem_rgba(217,119,87,0.25),inset_0_0_0_0.0625rem_rgba(255,255,255,0.10)] transition-[background-color,box-shadow] duration-(--duration-quick) ease-(--ease-premium) hover:bg-(--solus-send-hover) hover:shadow-[0_0.125rem_0.5rem_rgba(217,119,87,0.32),inset_0_0_0_0.0625rem_rgba(255,255,255,0.12)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium) motion-reduce:transition-none before:absolute before:top-1 before:bottom-1 before:left-0 before:w-px before:bg-white/30 before:opacity-25 before:content-[''] max-md:h-9"
          aria-label="More approve options"
        >
          <CaretDownIcon size={10} />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={6}
      class="w-[220px]"
    >
      <DropdownMenu.Item
        data-testid="plan-action-yes"
        onSelect={() => {
          open = false;
          onApprove("ask");
        }}
      >
        <RobotIcon size={14} />
        <span class="flex-1 text-left">Ask</span>
        {#if hasKeyboard}<span class="ml-auto"
            ><Kbd variant="inline">⌥Y</Kbd></span
          >{/if}
      </DropdownMenu.Item>
      {#if showNewSessionOption}
        <div class="h-px bg-(--solus-popover-border) mx-2 my-0.5"></div>
        <DropdownMenu.CheckboxItem
          data-testid="plan-action-new-session"
          bind:checked={startNewSession}
          closeOnSelect={false}
          class="px-3 py-1.5 text-xs font-secondary text-(--solus-text-secondary) lg:text-xs"
        >
          <span class="flex-1 text-left">Start new session</span>
        </DropdownMenu.CheckboxItem>
      {/if}
      {#if showWorktreeToggle}
        <DropdownMenu.Item
          data-testid="plan-action-worktree"
          closeOnSelect={false}
          onSelect={() => {
            useWorktree = !useWorktree;
          }}
        >
          <GitForkIcon
            size={14}
            class={useWorktree ? "text-(--solus-accent)" : ""}
          />
          <span class="flex-1 text-left">Use worktree</span>
          {#if useWorktree}<CheckIcon
              size={12}
              class="text-(--solus-accent)"
            />{/if}
          {#if hasKeyboard}<span class="ml-auto"
              ><Kbd variant="inline">⌥W</Kbd></span
            >{/if}
        </DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
</div>
