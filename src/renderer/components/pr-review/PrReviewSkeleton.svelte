<script lang="ts">
  import { GitPullRequestIcon } from "phosphor-svelte";
  import { Skeleton } from "../ui/skeleton";

  // The placeholder shown while a clicked PR's worktree is being fetched/checked
  // out, before PrReviewPane can mount. It mirrors the review header and the
  // Activity tab's masthead, timeline, composer, and folding right rail so the
  // real surface swaps in without a layout or colour jump.
  let { number, title }: { number: number; title?: string } = $props();

  const TABS = ["Activity", "Guide", "Diff"];
  const TIMELINE_ROWS = [0, 1, 2, 3];
  const FILE_ROWS = [0, 1, 2, 3];
</script>

<section class="flex h-full min-h-0 flex-col bg-card">
  <!-- Mirrors PrReviewPane's borderless 56px header and centered measure. -->
  <div class="@container h-[56px] shrink-0 overflow-hidden">
    <div
      class="mx-auto flex h-full w-full max-w-[min(1384px,100%)] items-center justify-between gap-4 pr-[clamp(20px,2.6vw,56px)] pl-[max(clamp(20px,2.6vw,56px),var(--solus-chrome-lead-inset,0px))]"
    >
      <div class="flex min-w-0 flex-1 items-center gap-3">
        <div
          class="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5"
          aria-hidden="true"
        >
          {#each TABS as tab, index (tab)}
            <span
              class={`flex h-full items-center rounded-md px-2.5 text-[12px] ${index === 0 ? "bg-card font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:ring-1 dark:ring-white/10 dark:shadow-none" : "font-normal text-muted-foreground"}`}
            >
              {tab}
            </span>
          {/each}
        </div>

        <div
          class="flex min-w-0 flex-1 items-center gap-1 text-[12px] text-muted-foreground @max-[1100px]:hidden"
        >
          <span class="shrink-0 font-mono text-foreground tabular-nums">#{number}</span>
          {#if title}
            <span class="shrink-0 opacity-40" aria-hidden="true">·</span>
            <span class="truncate">{title}</span>
          {/if}
        </div>
      </div>

      <!-- Reserve the same visual weight as checks, chat, and pane controls. -->
      <div class="flex shrink-0 items-center gap-1.5" aria-hidden="true">
        <Skeleton class="h-7 w-[72px] rounded-lg" />
        <Skeleton class="h-7 w-[54px] rounded-lg" />
        <Skeleton class="size-7 rounded-lg" />
        <Skeleton class="size-7 rounded-lg" />
      </div>
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div
      class="@container mx-auto flex w-full max-w-[min(1384px,100%)] flex-wrap gap-[clamp(24px,3vw,64px)] px-[clamp(20px,2.6vw,56px)] pt-[clamp(20px,1.8vw,32px)] pb-[clamp(32px,3vw,56px)]"
    >
      <main class="flex min-w-0 max-w-[1000px] flex-[1_1_520px] flex-col">
        <header>
          <p
            class="flex items-center gap-2 font-mono text-[9.5px] tracking-widest text-muted-foreground uppercase"
          >
            <GitPullRequestIcon size={10} class="shrink-0 text-primary" />
            <span class="tabular-nums">#{number}</span>
          </p>

          {#if title}
            <h1
              class="mt-3 text-[27px] leading-[1.25] font-semibold tracking-[-0.02em] text-pretty"
            >
              {title}
            </h1>
          {:else}
            <Skeleton class="mt-3 h-[34px] w-2/3 max-w-[560px] rounded-lg" />
          {/if}
        </header>

        <div class="mt-4 flex items-center gap-2">
          <Skeleton class="size-5 rounded-full" />
          <Skeleton class="h-3 w-24" />
          <Skeleton class="h-3 w-28" />
          <span class="text-[12px] text-muted-foreground opacity-40">·</span>
          <Skeleton class="h-6 w-40 rounded-md" />
        </div>

        <div class="mt-8 flex flex-col gap-2.5">
          <Skeleton class="h-3 w-full" />
          <Skeleton class="h-3 w-11/12" />
          <Skeleton class="h-3 w-3/4" />
        </div>

        <div class="mt-10 mb-4 flex h-7 items-center gap-2">
          <span
            class="text-[9.5px] font-medium tracking-widest text-muted-foreground uppercase"
          >
            Activity
          </span>
          <span class="flex-1"></span>
          <Skeleton class="h-7 w-44 rounded-lg" />
        </div>

        <!-- Ghost events sit on the same continuous spine as the loaded feed. -->
        <ol class="relative flex flex-col gap-5" aria-hidden="true">
          <span
            class="absolute top-2 bottom-2 left-[11px] w-px bg-border"
          ></span>
          {#each TIMELINE_ROWS as row (row)}
            <li class="relative flex gap-2">
              <Skeleton
                class="relative z-10 mt-0.5 size-[22px] shrink-0 rounded-full"
              />
              <div class="flex min-w-0 flex-1 flex-col gap-2 pt-1.5">
                <Skeleton
                  class={row === 0 ? "h-3 w-56" : "h-3 w-48"}
                />
                {#if row > 0 && row < 3}
                  <Skeleton class="h-8 w-full max-w-[520px] rounded-lg" />
                {/if}
              </div>
            </li>
          {/each}
        </ol>

        <div class="mt-8 flex items-center gap-3 rounded-xl bg-muted px-3.5 py-2.5">
          <Skeleton class="size-6 shrink-0 rounded-full" />
          <Skeleton class="h-3 flex-1" />
          <Skeleton class="size-7 shrink-0 rounded-lg" />
        </div>
      </main>

      <aside
        class="w-[clamp(280px,22%,360px)] shrink-0 @max-[1000px]:w-full"
      >
        <div class="flex flex-col gap-[26px]">
          <section
            class="flex flex-col gap-3 rounded-2xl bg-[color:color-mix(in_oklab,var(--muted)_55%,transparent)] px-4 py-4"
          >
            <div class="flex items-start gap-3">
              <Skeleton class="size-[26px] shrink-0 rounded-full" />
              <div class="min-w-0 flex-1">
                <Skeleton class="h-3.5 w-28" />
                <Skeleton class="mt-2 h-3 w-20" />
              </div>
            </div>
            <Skeleton class="h-8 w-full rounded-lg" />
            <div class="flex gap-2">
              <Skeleton class="h-7 flex-1 rounded-lg" />
              <Skeleton class="h-7 flex-1 rounded-lg" />
            </div>
          </section>

          <section>
            <div class="mb-2.5 flex items-center justify-between">
              <span
                class="text-[9.5px] font-medium tracking-widest text-muted-foreground uppercase"
                >Reviewers</span
              >
              <Skeleton class="h-3 w-20" />
            </div>
            <div class="flex items-center gap-2.5 px-2 py-1.5">
              <Skeleton class="size-[22px] shrink-0 rounded-full" />
              <Skeleton class="h-3 w-24" />
            </div>
          </section>

          <section>
            <div class="mb-2.5 flex items-center justify-between">
              <span
                class="text-[9.5px] font-medium tracking-widest text-muted-foreground uppercase"
                >Changed files</span
              >
              <Skeleton class="h-3 w-10" />
            </div>
            <ul class="-mx-2 flex flex-col" aria-hidden="true">
              {#each FILE_ROWS as row (row)}
                <li class="flex items-center gap-2.5 px-2 py-2">
                  <Skeleton class="size-3.5 shrink-0" />
                  <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                    <Skeleton
                      class={`h-3 ${row === 0 ? "w-4/5" : row === 1 ? "w-2/3" : row === 2 ? "w-3/4" : "w-1/2"}`}
                    />
                    <Skeleton class="h-2.5 w-2/5" />
                  </div>
                </li>
              {/each}
            </ul>
          </section>
        </div>
      </aside>
    </div>
  </div>
</section>
