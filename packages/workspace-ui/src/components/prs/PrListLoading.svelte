<div role="status" aria-live="polite" aria-busy="true" aria-label="Loading pull requests" class="pt-1.5">
  <div class="flex h-[30px] items-center gap-2.5 px-3 text-chrome-dense text-muted-foreground">
    <span aria-hidden="true" class="size-3 shrink-0 rounded-full border border-muted-foreground/20 border-t-muted-foreground/60 motion-safe:animate-spin"></span>
    <span>Loading pull requests</span>
    <span aria-hidden="true" class="h-px flex-1 bg-(--hairline)"></span>
  </div>
  <div aria-hidden="true" class="[mask-image:linear-gradient(to_bottom,black_45%,transparent)]">
    {#each [44, 61, 36, 51, 42, 57] as width, index (index)}
      <div class="flex h-[62px] items-center gap-3 px-3">
        <div class="h-4 w-3 shrink-0 rounded-sm bg-muted-foreground/10"></div>
        <div class="flex min-w-0 flex-1 flex-col gap-2.5">
          <div class="h-2.5 max-w-lg rounded-full bg-muted-foreground/10 w-(--title-width)" style={`--title-width: ${width}%`}></div>
          <div class="flex items-center gap-2">
            <div class="h-2 w-7 rounded-full bg-muted-foreground/8"></div>
            <div class="h-2 w-12 rounded-full bg-muted-foreground/8"></div>
            <div class="size-3.5 rounded-full bg-muted-foreground/8"></div>
            <div class="h-2 w-16 rounded-full bg-muted-foreground/8"></div>
          </div>
        </div>
        <div class="h-2 w-8 shrink-0 rounded-full bg-muted-foreground/8"></div>
      </div>
    {/each}
  </div>
</div>
