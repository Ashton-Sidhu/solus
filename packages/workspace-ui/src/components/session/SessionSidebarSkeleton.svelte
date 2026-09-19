<div class="flex min-h-0 flex-1 flex-col overflow-hidden px-3.5" role="status" aria-label="Loading sidebar">
  <div aria-hidden="true">
    <div class="flex flex-col gap-0.5">
      {#each [55, 66, 43] as width}
        <div class="flex h-7 items-center gap-2.5">
          <div class="size-3.5 shrink-0 rounded bg-(--solus-surface-secondary)"></div>
          <div class="h-2.5 rounded bg-(--solus-surface-secondary)" style:width="{width}%"></div>
        </div>
      {/each}
    </div>
    <div class="mt-6 mb-3 h-3 w-20 rounded bg-(--solus-surface-secondary)"></div>
    {#each [72, 54, 83, 47, 66, 58] as width, index}
      <div class="flex h-[2.625rem] items-center pl-2.5" style:opacity={1 - index * 0.14}>
        <div class="h-3 rounded bg-(--solus-surface-secondary)" style:width="{width}%"></div>
      </div>
    {/each}
  </div>
</div>
