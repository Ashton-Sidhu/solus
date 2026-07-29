<script lang="ts">
  import { PlusIcon, CameraIcon, PencilIcon } from "phosphor-svelte";
  import * as TooltipUI from "@renderer/components/ui/tooltip";

  interface Props {
    onAttachFile: () => void;
    onScreenshot?: (() => void) | null;
    onDesignMode?: (() => void) | null;
    disabled?: boolean;
  }
  let {
    onAttachFile,
    onScreenshot,
    onDesignMode,
    disabled = false,
  }: Props = $props();
</script>

<!--
  One bordered button group that expands on hover/focus: the `+` grows an "Add files"
  label, then the screenshot/design-mode actions slide out inside the same
  outline as a segmented button group. `group/add` scopes the reveal so nested
  triggers don't fight sibling groups on the same row.
-->
<div
  class="group/add flex h-8 items-center rounded-lg border border-(--solus-container-border) bg-(--solus-container-bg) font-secondary text-(--solus-text-secondary) shadow-xs"
>
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
        <button {...tooltipProps}
    type="button"
    onclick={onAttachFile}
    {disabled}
    class="flex h-full min-w-[30px] items-center justify-center rounded-lg text-[0.8125rem] transition-[background-color] hover:bg-(--solus-surface-hover) focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) disabled:opacity-50"
    style="cursor:{disabled ? 'not-allowed' : 'pointer'}"
    aria-label="Add files"
  >
    <PlusIcon size={16} class="flex-shrink-0" />
    <span
      class="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-[max-width,margin-left,opacity] duration-200 ease-out group-hover/add:ml-1 group-hover/add:max-w-[4.5rem] group-hover/add:opacity-100 group-focus-within/add:ml-1 group-focus-within/add:max-w-[4.5rem] group-focus-within/add:opacity-100"
      >Add files</span
    >
  </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={"Attach file (⌥⇧A)"} />
  </TooltipUI.Root>

  {#if onScreenshot || onDesignMode}
    <div
      class="flex h-full max-w-0 items-center overflow-hidden transition-[max-width] duration-200 ease-out group-hover/add:max-w-[4.75rem] group-focus-within/add:max-w-[4.75rem]"
    >
      <div
        class="mr-1 h-4 w-px flex-shrink-0 bg-(--solus-container-border)"
      ></div>
      {#if onScreenshot}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props: tooltipProps })}
              <button {...tooltipProps}
          type="button"
          onclick={onScreenshot}
          {disabled}
          class="flex h-full w-8 flex-shrink-0 items-center justify-center rounded-lg text-(--solus-text-tertiary) transition-[background-color] hover:bg-(--solus-surface-hover) focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) disabled:opacity-50"
        >
          <CameraIcon size={16} />
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
          class="flex h-full w-8 flex-shrink-0 items-center justify-center rounded-lg text-(--solus-text-tertiary) transition-[background-color] hover:bg-(--solus-surface-hover) focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) disabled:opacity-50"
        >
          <PencilIcon size={16} />
        </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content value={"Design mode (⌥⇧I)"} />
        </TooltipUI.Root>
      {/if}
    </div>
  {/if}
</div>
