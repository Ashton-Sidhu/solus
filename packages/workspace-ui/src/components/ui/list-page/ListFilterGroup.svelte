<script lang="ts" generics="T extends string">
  import { MediaQuery } from "svelte/reactivity";
  import * as DropdownMenu from "../dropdown-menu";
  import type { ListIcon } from "./list-page";

  let { label, icon: Icon, options, selected, onChange, multiple = false, emptyLabel = "All", showAll = false }: {
    label: string;
    icon?: ListIcon;
    options: { value: T; label: string; count?: number }[];
    selected: T[];
    onChange: (values: T[]) => void;
    multiple?: boolean;
    emptyLabel?: string;
    showAll?: boolean;
  } = $props();
  const narrowViewport = new MediaQuery("(max-width: 40rem)");
  const valueLabel = $derived(selected.length === 0 ? emptyLabel : selected.length === 1
    ? options.find((option) => option.value === selected[0])?.label ?? selected[0]
    : `${selected.length} selected`);
</script>

<DropdownMenu.Sub>
  <DropdownMenu.SubTrigger>
    {#if Icon}<Icon size={14} class="shrink-0 text-muted-foreground" />{/if}
    <span class="min-w-0 flex-1 truncate">{label}</span>
    <span class="max-w-24 truncate text-muted-foreground">{valueLabel}</span>
  </DropdownMenu.SubTrigger>
  <DropdownMenu.SubContent side={narrowViewport.current ? "bottom" : "right"} align={narrowViewport.current ? "end" : "start"} collisionPadding={8} class="flex max-h-[min(32rem,calc(var(--bits-dropdown-menu-content-available-height,36rem)-1rem))] w-72 max-w-[calc(100vw-1rem)] flex-col overflow-y-auto p-2 pointer-fine:[.is-laptop-display_&]:w-60">
    <div class="px-2 pt-0.5 pb-1.5 text-menu text-muted-foreground">{label}</div>
    {#if multiple}
      {#each options as option (option.value)}
        <DropdownMenu.CheckboxItem
          checked={selected.includes(option.value)}
          closeOnSelect={false}
          onCheckedChange={(checked) => onChange(checked ? [...selected.filter((value) => value !== option.value), option.value] : selected.filter((value) => value !== option.value))}
        >
          <span class="min-w-0 flex-1 truncate">{option.label}</span>
          {#if option.count !== undefined}<span class="mr-1 tabular-nums text-muted-foreground">{option.count}</span>{/if}
        </DropdownMenu.CheckboxItem>
      {/each}
      <DropdownMenu.Separator />
      <DropdownMenu.Item closeOnSelect={false} onSelect={() => onChange(showAll && selected.length !== options.length ? options.map((option) => option.value) : [])}>
        {showAll ? selected.length === options.length ? "Show none" : "Show all" : "Show all projects"}
      </DropdownMenu.Item>
    {:else}
      <DropdownMenu.RadioGroup value={selected[0]} onValueChange={(value) => {
        const option = options.find((option) => option.value === value);
        if (option) onChange([option.value]);
      }}>
        {#each options as option (option.value)}
          <DropdownMenu.RadioItem value={option.value} class="data-[state=checked]:bg-[var(--solus-menu-hover-ink)]">
            <span class="min-w-0 flex-1 truncate">{option.label}</span>
            {#if option.count !== undefined}<span class="mr-1 tabular-nums text-muted-foreground">{option.count}</span>{/if}
          </DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    {/if}
  </DropdownMenu.SubContent>
</DropdownMenu.Sub>
