<script lang="ts">
  import { ArrowsDownUpIcon, CaretDownIcon, CaretUpIcon } from 'phosphor-svelte'

  let { direction }: { direction: false | 'asc' | 'desc' } = $props()
</script>

<span class="relative size-3 shrink-0" aria-hidden="true">
  <ArrowsDownUpIcon
    class="absolute inset-0 size-3 transition-[opacity,scale,filter] duration-200 {direction
      ? 'scale-[0.25] opacity-0 blur-[4px]'
      : 'scale-100 opacity-0 blur-0 group-hover/sort:opacity-55'}"
    weight="bold"
  />
  <CaretUpIcon
    class="absolute inset-0 size-3 transition-[opacity,scale,filter] duration-200 {direction === 'asc'
      ? 'scale-100 opacity-100 blur-0'
      : 'scale-[0.25] opacity-0 blur-[4px]'}"
    weight="bold"
  />
  <CaretDownIcon
    class="absolute inset-0 size-3 transition-[opacity,scale,filter] duration-200 {direction === 'desc'
      ? 'scale-100 opacity-100 blur-0'
      : 'scale-[0.25] opacity-0 blur-[4px]'}"
    weight="bold"
  />
</span>
