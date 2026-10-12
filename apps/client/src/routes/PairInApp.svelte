<script lang="ts">
  import { Globe as BrowserIcon, Smartphone as AppIcon } from "@lucide/svelte";
  import { cn } from "@solus/workspace-ui/lib/utils";
  import { cardClass } from "./lib/hostless-styles";

  /** `appLink` opens the Solus app, which pairs itself; `onContinue` pairs this browser instead. */
  let { appLink, onContinue }: { appLink: string; onContinue: () => void } = $props();
</script>

<!-- A phone that scanned a host's pairing code with its camera lands here.
     The code is used once, so the person chooses which one pairs: the app
     or this browser. -->
<div
  class="@container flex min-h-dvh w-full flex-col items-center justify-center overflow-y-auto bg-(--solus-bg) px-5 py-10"
  data-solus-ui
>
  <div class="flex w-full max-w-[32rem] flex-col">
    <h1 class="text-center text-pretty text-2xl leading-[1.3] font-medium tracking-[-0.018em] text-(--solus-text-primary)">
      Pair with this host
    </h1>
    <p class="mt-2 mb-6 text-center text-workspace-chrome text-pretty text-(--solus-text-tertiary)">
      Use the Solus app on this phone, or continue in the browser.
    </p>
    <main class="flex flex-col gap-2">
      <a href={appLink} class={cn(cardClass, "px-4 py-3.5 text-left")}>
        <span class="grid size-8 shrink-0 place-items-center rounded-[0.5625rem] bg-(--solus-surface-hover) text-(--solus-text-tertiary)">
          <AppIcon size={15} />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-workspace-chrome font-medium text-(--solus-text-primary)">Open in the Solus app</span>
          <span class="mt-0.5 block truncate text-chrome-dense text-(--solus-text-tertiary)">The app checks the host before it pairs</span>
        </span>
        <span class="shrink-0 rounded-full bg-(--solus-accent-soft) px-2.5 py-0.5 text-xs text-(--solus-accent)">Open</span>
      </a>
      <button type="button" class={cn(cardClass, "px-4 py-3.5 text-left")} onclick={onContinue}>
        <span class="grid size-8 shrink-0 place-items-center rounded-[0.5625rem] bg-(--solus-surface-hover) text-(--solus-text-tertiary)">
          <BrowserIcon size={15} />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-workspace-chrome font-medium text-(--solus-text-primary)">Continue in the browser</span>
          <span class="mt-0.5 block truncate text-chrome-dense text-(--solus-text-tertiary)">Pair this browser with the host</span>
        </span>
        <span class="shrink-0 rounded-full bg-(--solus-accent-soft) px-2.5 py-0.5 text-xs text-(--solus-accent)">Pair</span>
      </button>
    </main>
  </div>
</div>
