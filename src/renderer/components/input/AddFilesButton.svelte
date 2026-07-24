<script lang="ts">
  import { PlusIcon, CameraIcon, PencilIcon } from "phosphor-svelte";
  import { tooltip } from "../../lib/tooltip";

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
  One bordered pill that expands on hover/focus: the `+` grows an "Add files"
  label, then the screenshot/design-mode actions slide out inside the same
  outline as a segmented button group. `group/add` scopes the reveal so nested
  triggers don't fight sibling groups on the same row.
-->
<div
  class="group/add flex h-8 items-center rounded-full border border-(--solus-container-border) text-(--solus-text-secondary)"
>
  <button
    type="button"
    onclick={onAttachFile}
    {disabled}
    class="flex h-full items-center gap-1 rounded-full pl-2 pr-2 text-[0.8125rem] transition-[background-color,color] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) disabled:opacity-50"
    style="cursor:{disabled ? 'not-allowed' : 'pointer'}"
    use:tooltip={"Attach file (⌥⇧A)"}
    aria-label="Add files"
  >
    <PlusIcon size={16} class="flex-shrink-0" />
    <span
      class="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-[max-width,opacity] duration-200 ease-out group-hover/add:max-w-[4.5rem] group-hover/add:opacity-100 group-focus-within/add:max-w-[4.5rem] group-focus-within/add:opacity-100"
      >Add files</span
    >
  </button>

  {#if onScreenshot || onDesignMode}
    <div
      class="flex h-full max-w-0 items-center overflow-hidden transition-[max-width] duration-200 ease-out group-hover/add:max-w-[4.75rem] group-focus-within/add:max-w-[4.75rem]"
    >
      <div
        class="mr-1 h-4 w-px flex-shrink-0 bg-(--solus-container-border)"
      ></div>
      {#if onScreenshot}
        <button
          type="button"
          onclick={onScreenshot}
          {disabled}
          class="flex h-full w-8 flex-shrink-0 items-center justify-center rounded-full text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) disabled:opacity-50"
          use:tooltip={"Take screenshot (⌥⇧S)"}
        >
          <CameraIcon size={16} />
        </button>
      {/if}
      {#if onDesignMode}
        <button
          type="button"
          onclick={onDesignMode}
          {disabled}
          class="flex h-full w-8 flex-shrink-0 items-center justify-center rounded-full text-(--solus-text-tertiary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) disabled:opacity-50"
          use:tooltip={"Design mode (⌥⇧I)"}
        >
          <PencilIcon size={16} />
        </button>
      {/if}
    </div>
  {/if}
</div>
