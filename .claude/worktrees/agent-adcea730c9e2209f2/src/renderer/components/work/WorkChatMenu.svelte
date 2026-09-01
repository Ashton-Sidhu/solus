<script lang="ts">
  import { ClockCounterClockwiseIcon, PlusIcon } from 'phosphor-svelte'
  import * as DropdownMenu from '../ui/dropdown-menu'
  import type { SessionMeta } from '../../../shared/types'

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
  <DropdownMenu.Content customAnchor={triggerEl} side="top" align="end" sideOffset={6} class="w-[224px]" aria-label="Document chat actions" onInteractOutside={(event) => { if (triggerEl?.contains(event.target as Node)) event.preventDefault() }}>
    {#each options as option, index (option.id)}
      <DropdownMenu.Item
        disabled={loading}
        onSelect={() => handleSelect(index)}
      >
        <span class="mt-[0.09375rem] flex shrink-0 items-center justify-center self-start text-inherit">
          <option.Icon size={14} />
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-[0.03125rem]">
          <span class="truncate text-[0.6875rem] leading-[1.3] font-medium text-(--solus-text-primary)">{option.label}</span>
          {#if option.id === 'resume'}
            <span class="truncate text-[0.625rem] leading-[1.3] text-(--solus-text-tertiary)">
              {#if originalSessionMeta}
                {originalSessionMeta.title || 'Unnamed session'}
              {:else}
                Original session unavailable — will start a new chat
              {/if}
            </span>
          {:else if option.id === 'new'}
            <span class="truncate text-[0.625rem] leading-[1.3] text-(--solus-text-tertiary)">Start fresh with this doc attached</span>
          {/if}
        </span>
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
