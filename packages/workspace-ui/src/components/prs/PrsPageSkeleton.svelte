<script lang="ts">
  import PrListLoading from "./PrListLoading.svelte";
</script>

<div class="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
  <div class="mx-auto min-h-0 w-full max-w-[72rem] overflow-hidden px-8 pt-[42px] @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[34rem]:px-4">
    <div class="flex h-[31px] items-center pb-[13px] box-content">
      <h1 class="px-2.5 text-[length:calc(var(--text-workspace-chrome)+2px)] font-semibold tracking-[-0.013em] text-foreground">Pull Requests</h1>
    </div>
    <div aria-hidden="true" class="flex h-8 items-center gap-2 pb-[14px] box-content">
      <div class="flex h-8 min-w-0 flex-1 items-center rounded-lg border border-border/50 px-3">
        <div class="h-2 w-48 max-w-3/5 rounded-full bg-muted-foreground/8"></div>
      </div>
      <div class="h-8 w-16 shrink-0 rounded-lg border border-border/50"></div>
      <div class="h-8 w-20 shrink-0 rounded-lg border border-border/50"></div>
    </div>
    <PrListLoading />
  </div>
</div>
