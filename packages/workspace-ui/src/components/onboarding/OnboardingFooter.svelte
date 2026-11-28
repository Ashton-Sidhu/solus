<script lang="ts">
  /**
   * The footer under the timeline: a hint, the quiet Skip (`esc`) or, on the
   * cloud ready state, Invite your team, and the one accent primary (`↵`).
   */
  import { LoaderCircle as SpinnerIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import type { Footer } from "./lib/onboarding-model";

  interface Props {
    footer: Footer;
    isBusy: boolean;
    onprimary: () => void;
    onsecondary: () => void;
    primaryRef?: HTMLButtonElement | null;
  }

  let { footer, isBusy, onprimary, onsecondary, primaryRef = $bindable(null) }: Props = $props();
</script>

<div class="flex gap-4.5 border-t border-(--hairline) pt-7">
  <span class="w-5.5 shrink-0" aria-hidden="true"></span>
  <div class="flex min-w-0 flex-1 flex-wrap items-center gap-3.5">
    <p class="m-0 min-w-0 flex-1 text-[13px] leading-4.5 text-(--solus-text-tertiary)" aria-live="polite">{footer.hint}</p>
    <div class="flex items-center gap-2">
      {#if footer.secondary}
        <Button
          variant="ghost"
          class="h-9.5 gap-2 rounded-md pr-2.5 pl-3.5 text-[14px] leading-5 font-medium text-(--solus-text-secondary)"
          disabled={isBusy && footer.secondary === "skip"}
          onclick={onsecondary}
        >
          {footer.secondary === "invite" ? "Invite your team" : "Skip"}
          {#if footer.secondary === "skip"}
            <kbd class="flex h-5 items-center rounded-[4px] border border-(--hairline) px-1.25 font-mono text-[11px] leading-3.5 font-normal text-(--solus-text-tertiary)">esc</kbd>
          {/if}
        </Button>
      {/if}
      <Button
        bind:ref={primaryRef}
        class="h-9.5 gap-2.5 rounded-md pr-2.5 pl-4 text-[14px] leading-5 font-medium"
        disabled={!footer.primaryEnabled}
        onclick={onprimary}
      >
        {#if isBusy}<SpinnerIcon size={14} class="animate-spin motion-reduce:animate-none" />{/if}
        {footer.primaryLabel}
        <kbd class="flex h-5 items-center rounded-[4px] bg-[color:color-mix(in_oklch,var(--primary-foreground)_22%,transparent)] px-1.25 font-mono text-[11px] leading-3.5 font-normal">↵</kbd>
      </Button>
    </div>
  </div>
</div>
