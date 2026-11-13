<div class="flex min-h-0 flex-1 overflow-hidden" role="status" aria-label="Loading sidebar">
  <div class="flex w-11 shrink-0 flex-col items-center gap-1" aria-hidden="true">
    {#each [0, 1, 2] as place (place)}
      <div class="flex size-8 items-center justify-center">
        <div class="size-4 rounded bg-(--solus-surface-secondary)"></div>
      </div>
    {/each}
  </div>
  <div class="min-w-0 flex-1 px-3.5" aria-hidden="true">
    <div class="mt-2.5 mb-3 h-3 w-20 rounded bg-(--solus-surface-secondary)"></div>
    {#each [72, 54, 83, 47, 66, 58] as width, index}
      <div class="flex h-[2.625rem] items-center pl-2.5" style:opacity={1 - index * 0.14}>
        <div class="h-3 rounded bg-(--solus-surface-secondary)" style:width="{width}%"></div>
      </div>
    {/each}
  </div>
</div>
