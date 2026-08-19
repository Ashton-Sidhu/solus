<script lang="ts">
  import { MagnifyingGlassIcon, TableIcon } from 'phosphor-svelte'

  let {
    filtered,
    title,
    description,
  }: { filtered: boolean; title: string; description?: string } = $props()
</script>

<div class="flex min-h-36 flex-col items-center justify-center px-6 py-8 text-center">
  <span
    class="mb-3 flex size-9 items-center justify-center rounded-xl bg-[var(--wash-2)] text-muted-foreground shadow-[inset_0_0_0_1px_var(--hairline-strong),0_1px_2px_rgba(0,0,0,0.03)]"
  >
    {#if filtered}
      <MagnifyingGlassIcon class="size-4" aria-hidden="true" />
    {:else}
      <TableIcon class="size-4" aria-hidden="true" />
    {/if}
  </span>
  <span class="text-[0.8125rem] font-medium text-foreground">{title}</span>
  {#if description}
    <span class="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</span>
  {/if}
</div>
