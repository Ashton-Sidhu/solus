<script lang="ts">
  import { ClockCounterClockwiseIcon, PlusIcon } from 'phosphor-svelte'
  import Dropdown from '../ui/Dropdown.svelte'
  import DropdownItem from '../ui/DropdownItem.svelte'
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

  let selectedIndex = $state(0)

  const options = [
    { id: 'resume', label: 'Resume original', Icon: ClockCounterClockwiseIcon },
    { id: 'new', label: 'New chat', Icon: PlusIcon },
  ]

  $effect(() => {
    if (!open) selectedIndex = 0
  })

  function handleKeydown(e: KeyboardEvent) {
    if (!open) return
    if (e.key === 'ArrowDown') {
      selectedIndex = (selectedIndex + 1) % options.length
      e.preventDefault()
    } else if (e.key === 'ArrowUp') {
      selectedIndex = (selectedIndex - 1 + options.length) % options.length
      e.preventDefault()
    } else if (e.key === 'Enter') {
      handleSelect(selectedIndex)
      e.preventDefault()
    }
  }

  function handleSelect(index: number) {
    const option = options[index]
    if (option?.id === 'resume') onResume?.()
    else if (option?.id === 'new') onNew?.()
    open = false
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<Dropdown bind:open {triggerEl} align="top" anchor="right" width={224}>
  <div class="flex flex-col py-1" role="menu" aria-label="Document chat actions">
    {#each options as option, index (option.id)}
      <DropdownItem
        disabled={loading}
        focused={selectedIndex === index && !loading}
        onclick={() => handleSelect(index)}
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
      </DropdownItem>
    {/each}
  </div>
</Dropdown>
