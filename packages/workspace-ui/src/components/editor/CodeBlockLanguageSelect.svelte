<script lang="ts">
  import { untrack } from "svelte";
  import { Check, ChevronDown } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";

  interface LanguageOption {
    value: string;
    label: string;
  }

  interface Props {
    initialValue: string;
    options: ReadonlyArray<LanguageOption>;
    onValueChange: (value: string) => void;
  }

  let { initialValue, options, onValueChange }: Props = $props();
  let value = $state(untrack(() => initialValue));

  const label = $derived(options.find((option) => option.value === value)?.label ?? "plain");

  function selectLanguage(nextValue: string) {
    value = nextValue;
    onValueChange(nextValue);
  }

  export function setLanguage(nextValue: string) {
    value = nextValue;
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    aria-label="Code block language"
    title="Language"
    onmousedown={(event) => event.stopPropagation()}
    class="relative inline-flex h-[1.375rem] items-center gap-1 rounded-[0.3125rem] border-0 bg-transparent px-1.5 py-0 font-(family-name:--solus-doc-mono) text-workspace-chrome uppercase text-(--solus-text-tertiary) transition-[background-color,color,transform] after:absolute after:inset-x-0 after:-inset-y-[0.5625rem] hover:bg-(--solus-surface-hover) hover:text-(--solus-doc-ink-strong) active:scale-[0.96] data-[state=open]:bg-(--solus-surface-hover) data-[state=open]:text-(--solus-doc-ink-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent) pointer-coarse:min-h-11"
  >
    {label}
    <ChevronDown size={12} />
  </DropdownMenu.Trigger>
  <DropdownMenu.Content
    side="bottom"
    align="start"
    sideOffset={5}
    class="max-h-72 w-36"
  >
    {#each options as option (option.value)}
      <DropdownMenu.Item onclick={() => selectLanguage(option.value)}>
        <span class="min-w-0 flex-1">{option.label}</span>
        {#if option.value === value}
          <Check size={12} class="text-(--solus-accent)" />
        {/if}
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
