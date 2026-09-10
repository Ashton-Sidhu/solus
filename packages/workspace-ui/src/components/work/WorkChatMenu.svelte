<script lang="ts">
  import { History as ClockCounterClockwiseIcon, Plus as PlusIcon } from "@lucide/svelte";
  import * as DropdownMenu from '../ui/dropdown-menu'
  import type { SessionMeta } from '@solus/contracts/types'

  interface Props {
    open: boolean
    triggerEl: HTMLElement | null
    onResume?: () => void
    onNew?: () => void
    originalSessionMeta?: SessionMeta | null
    loading?: boolean
  }

  let {
    open = $bindable(),
    triggerEl,
    onResume,
    onNew,
    originalSessionMeta,
    loading = false,
  }: Props = $props()

  const options = [
    { id: 'resume', label: 'Resume original', Icon: ClockCounterClockwiseIcon },
    { id: 'new', label: 'New chat', Icon: PlusIcon },
  ]

  function handleSelect(index: number) {
    const option = options[index]
    if (option?.id === 'resume') onResume?.()
    else if (option?.id === 'new') onNew?.()
    open = false
  }
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Content customAnchor={triggerEl} side="bottom" align="end" sideOffset={6} collisionPadding={8} class="w-[19rem]" aria-label="Document chat actions" onInteractOutside={(event) => { if (triggerEl?.contains(event.target as Node)) event.preventDefault() }}>
    {#each options as option, index (option.id)}
      <DropdownMenu.Item
        disabled={loading}
        class="h-auto py-1.5 text-workspace-chrome"
        onSelect={() => handleSelect(index)}
      >
        <option.Icon size={14} />
        <span class="flex min-w-0 flex-1 flex-col gap-[0.0625rem]">
          <span class="truncate">{option.label}</span>
          {#if option.id === 'resume'}
            <span class="truncate text-xs leading-[1.25] text-(--solus-text-tertiary)">
              {#if originalSessionMeta}
                {originalSessionMeta.title || 'Unnamed session'}
              {:else}
                Original session unavailable — will start a new chat
              {/if}
            </span>
          {:else if option.id === 'new'}
            <span class="truncate text-xs leading-[1.25] text-(--solus-text-tertiary)">Start fresh with this doc attached</span>
          {/if}
        </span>
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
