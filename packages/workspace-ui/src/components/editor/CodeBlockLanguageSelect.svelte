<script lang="ts">
  import { untrack } from "svelte";
  import * as Select from "../ui/select";

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
    if (nextValue === value) return;
    value = nextValue;
    onValueChange(nextValue);
  }

  export function setLanguage(nextValue: string) {
    value = nextValue;
  }
</script>

<Select.Root type="single" {value} onValueChange={selectLanguage}>
  <Select.Trigger
    aria-label="Code block language"
    title="Language"
    size="sm"
    onmousedown={(event) => event.stopPropagation()}
    class="relative h-[1.375rem] gap-1 rounded-[0.3125rem] border-0 bg-transparent px-1.5 py-0 font-(family-name:--solus-doc-mono) text-xs uppercase text-(--solus-text-tertiary) transition-[background-color,color,transform] after:absolute after:inset-x-0 after:-inset-y-[0.5625rem] hover:bg-(--solus-surface-hover) hover:text-(--solus-doc-ink-strong) active:scale-[0.96] data-[state=open]:bg-(--solus-surface-hover) data-[state=open]:text-(--solus-doc-ink-strong) focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent dark:hover:bg-(--solus-surface-hover) [&_svg]:size-2.5"
  >
    {label}
  </Select.Trigger>
  <Select.Content
    side="bottom"
    align="start"
    sideOffset={5}
    class="z-[10002] max-h-72 w-36"
  >
    {#each options as option (option.value)}
      <Select.Item value={option.value} label={option.label} />
    {/each}
  </Select.Content>
</Select.Root>
