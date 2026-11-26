<script lang="ts">
  /** The building blocks of one policy: each common rule it sets, with a choice
   *  and Remove, and Add rule for the others. Each change rewrites the JSON. */
  import { Plus as PlusIcon, X as RemoveIcon } from "@lucide/svelte";
  import type { PolicyKind } from "@solus/contracts/policy";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import SettingsSelect from "../SettingsSelect.svelte";
  import { applyPolicyBlock, blockDocument, POLICY_BLOCK_GROUPS, policyBlocksFor, type PolicyBlock } from "./lib/policy-blocks";

  let { kind, text, onChange }: { kind: PolicyKind; text: string; onChange: (text: string) => void } = $props();

  const document = $derived(blockDocument(text));
  const blocks = $derived(policyBlocksFor(kind));
  const setBlocks = $derived(document ? blocks.filter((block) => block.read(document) !== undefined) : []);
  const unsetBlocks = $derived(document ? blocks.filter((block) => block.read(document) === undefined) : []);

  function choicesOf(block: PolicyBlock, value: string) {
    return block.choices.some((choice) => choice.value === value) ? block.choices : [...block.choices, { value, label: "Set in JSON" }];
  }

  function set(block: PolicyBlock, value: string | undefined) {
    if (!document) return;
    onChange(applyPolicyBlock(document, block, value));
    requestInputFocus();
  }
</script>

<div class="flex flex-col gap-2 rounded-lg border border-border p-3">
  <div class="flex items-center justify-between gap-2">
    <h4 class="text-xs font-medium text-foreground">Rules</h4>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button {...props} variant="outline" disabled={!document || unsetBlocks.length === 0}>
            <PlusIcon size={16} />
            Add rule
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="max-h-96 w-[min(22rem,calc(100vw-2rem))] overflow-y-auto">
        {#each POLICY_BLOCK_GROUPS as group (group)}
          {@const groupBlocks = unsetBlocks.filter((block) => block.group === group)}
          {#if groupBlocks.length > 0}
            <DropdownMenu.Group>
              <DropdownMenu.GroupHeading>{group}</DropdownMenu.GroupHeading>
              {#each groupBlocks as block (block.id)}
                <DropdownMenu.Item onSelect={() => set(block, block.initial)}>
                  <div class="flex min-w-0 flex-col">
                    <span>{block.label}</span>
                    <span class="text-xs text-muted-foreground">{block.description}</span>
                  </div>
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.Group>
          {/if}
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>

  {#if !document}
    <p class="text-xs text-muted-foreground">Fix the JSON below to use the rules.</p>
  {:else if setBlocks.length === 0}
    <p class="text-xs text-muted-foreground">No rules yet. Add a rule, or write one in the JSON below.</p>
  {:else}
    <ul class="flex flex-col gap-2">
      {#each setBlocks as block (block.id)}
        {@const value = block.read(document) ?? block.initial}
        <li class="flex items-center gap-3">
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-xs text-foreground">{block.label}</span>
            <span class="truncate text-xs text-muted-foreground">{block.description}</span>
          </div>
          <!-- One width for every rule's choice, so the column of choices lines up. -->
          <div class="flex w-56 shrink-0 items-center gap-1">
            <div class="min-w-0 flex-1 *:w-full">
              <SettingsSelect options={choicesOf(block, value)} {value} onSelect={(next) => set(block, next)} ariaLabel={block.label} />
            </div>
            <Button variant="ghost" size="icon" class="shrink-0" aria-label={`Remove ${block.label}`} onclick={() => set(block, undefined)}>
              <RemoveIcon size={16} />
            </Button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
