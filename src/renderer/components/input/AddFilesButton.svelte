<script lang="ts">
  import { PlusIcon, CameraIcon, PencilIcon } from "phosphor-svelte";
  import * as TooltipUI from "@renderer/components/ui/tooltip";

  interface Props {
    onAttachFile: () => void;
    onScreenshot?: (() => void) | null;
    onDesignMode?: (() => void) | null;
    disabled?: boolean;
    attachDisabled?: boolean;
    attachTooltip?: string;
  }
  let {
    onAttachFile,
    onScreenshot,
    onDesignMode,
    disabled = false,
    attachDisabled = false,
    attachTooltip = "Attach file (⌥⇧A)",
  }: Props = $props();
</script>

<!--
  Same shell as the mode and model pickers — 30px, hairline, with a fill that
  matches the composer — so the row reads as one set of controls. It is the
  only one that grows: hovering or
  focusing it reveals the "Add files" label and the screenshot/design-mode
  actions inside that same outline, as a segmented group. Width, opacity and a
  short slide animate together so the icons arrive rather than unclip. The
  gutter lives on the shell, so the `+` and the trailing icon keep the same
  breathing room from the border that the padded pickers have.
  `group/add` scopes the reveal so nested triggers don't fight sibling groups on
  the same row.
-->
<div
  class="group/add flex h-[1.875rem] items-center rounded-lg border-[0.5px] border-(--solus-container-border) bg-(--solus-input-pill-bg) px-1.5 font-secondary text-(--solus-text-tertiary) transition-[border-color] duration-[var(--duration-base)] ease-(--ease-premium)"
>
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
        <button {...tooltipProps}
    type="button"
    onclick={onAttachFile}
    disabled={disabled || attachDisabled}
    class="flex h-full min-w-[1.25rem] items-center justify-center rounded-lg text-[0.78125rem] transition-[color] duration-[var(--duration-quick)] hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) disabled:opacity-50"
    style="cursor:{disabled || attachDisabled ? 'not-allowed' : 'pointer'}"
    aria-label="Add files"
  >
    <PlusIcon size={15} class="flex-shrink-0" />
    <span
      class="max-w-0 translate-x-[-0.25rem] overflow-hidden whitespace-nowrap opacity-0 transition-[max-width,margin-left,opacity,translate] duration-[var(--duration-base)] ease-(--ease-premium) group-hover/add:ml-1.5 group-hover/add:max-w-[4.5rem] group-hover/add:translate-x-0 group-hover/add:opacity-100 group-focus-within/add:ml-1.5 group-focus-within/add:max-w-[4.5rem] group-focus-within/add:translate-x-0 group-focus-within/add:opacity-100"
      >Add files</span
    >
  </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={attachTooltip} />
  </TooltipUI.Root>

  {#if onScreenshot || onDesignMode}
    <div
      class="flex h-full max-w-0 items-center overflow-hidden opacity-0 transition-[max-width,opacity,padding-left] duration-[var(--duration-base)] ease-(--ease-premium) group-hover/add:max-w-[4.5rem] group-hover/add:pl-2 group-hover/add:opacity-100 group-focus-within/add:max-w-[4.5rem] group-focus-within/add:pl-2 group-focus-within/add:opacity-100"
    >
      <div class="mr-1 h-4 w-px flex-shrink-0 bg-(--solus-container-border)"></div>
      {#if onScreenshot}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props: tooltipProps })}
              <button {...tooltipProps}
          type="button"
          onclick={onScreenshot}
          {disabled}
          class="flex h-full w-[1.5rem] flex-shrink-0 items-center justify-center rounded-lg transition-[color] duration-[var(--duration-quick)] hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) disabled:opacity-50"
        >
          <CameraIcon size={15} />
        </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content value={"Take screenshot (⌥⇧S)"} />
        </TooltipUI.Root>
      {/if}
      {#if onDesignMode}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props: tooltipProps })}
              <button {...tooltipProps}
          type="button"
          onclick={onDesignMode}
          {disabled}
          class="flex h-full w-[1.5rem] flex-shrink-0 items-center justify-center rounded-lg transition-[color] duration-[var(--duration-quick)] hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) disabled:opacity-50"
        >
          <PencilIcon size={15} />
        </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content value={"Design mode (⌥⇧I)"} />
        </TooltipUI.Root>
      {/if}
    </div>
  {/if}
</div>
