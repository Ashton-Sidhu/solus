<script lang="ts">
  import { MagnifyingGlassIcon, XIcon } from "phosphor-svelte";
  import { Input } from "../input";
  import { cn } from "@renderer/lib/utils.js";

  interface Props {
    value?: string;
    ref?: HTMLInputElement | null;
    placeholder?: string;
    onkeydown?: (event: KeyboardEvent) => void;
    /** Overrides on the field shell — e.g. a denser variant in a settings rail. */
    class?: string;
  }

  let {
    value = $bindable(""),
    ref = $bindable(null),
    placeholder = "Search…",
    onkeydown,
    class: className,
  }: Props = $props();
</script>

<div
  class={cn(
    "flex min-w-0 flex-1 basis-56 items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--solus-container-border)_60%,transparent)] bg-transparent px-2.5 py-[0.375rem] transition-[border-color] duration-100 ease-in-out focus-within:border-[color-mix(in_srgb,var(--solus-accent)_45%,transparent)] @max-[44rem]:basis-full",
    className,
  )}
>
  <MagnifyingGlassIcon size={14} class="shrink-0 text-(--solus-text-tertiary)" />
  <Input
    bind:ref
    bind:value
    type="text"
    {placeholder}
    {onkeydown}
    class="h-auto rounded-none border-0 bg-transparent p-0 text-[0.7813rem] shadow-none focus-visible:ring-0 dark:bg-transparent [@media(pointer:coarse)]:text-[16px]"
  />
  {#if value}
    <button
      type="button"
      class="relative grid size-[1.125rem] shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-(--solus-surface-hover) text-(--solus-text-tertiary) transition-colors duration-100 after:absolute after:-inset-1.5 hover:text-(--solus-text-primary) focus-visible:text-(--solus-text-primary) focus-visible:outline-none"
      onclick={() => {
        value = "";
        ref?.focus();
      }}
      aria-label="Clear search"
      title="Clear search"
    >
      <XIcon size={10} weight="bold" />
    </button>
  {/if}
</div>
