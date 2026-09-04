<script lang="ts">
  import { ExternalLink as ArrowSquareOutIcon } from "@lucide/svelte";

  /**
   * Which pull request this is, the way its host names it: `owner/repo` in
   * quiet type and the number as the link to the host page. The two homes it
   * has — the masthead row above a page-shaped review and the eyebrow over the
   * title when there is no masthead — read identically.
   */
  let {
    repo,
    number,
    onOpenPage,
  }: {
    /** `owner/repo`, or null when the target does not carry its repository. */
    repo: string | null;
    number: number;
    /** Open the pull request on its host. Absent until the host page is known. */
    onOpenPage?: () => void;
  } = $props();
</script>

<span class="flex min-w-0 items-center gap-1.5 text-workspace-chrome text-muted-foreground">
  {#if repo}
    <span class="min-w-0 truncate">{repo}</span>
  {/if}
  <button
    type="button"
    class="flex shrink-0 cursor-pointer items-center gap-1 rounded-sm font-medium text-(--solus-art-positive) tabular-nums transition-colors enabled:hover:underline disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
    disabled={!onOpenPage}
    title={onOpenPage ? "Open on the host" : undefined}
    onclick={onOpenPage}
  >
    #{number}
    {#if onOpenPage}
      <ArrowSquareOutIcon size={11} class="opacity-70" aria-hidden="true" />
    {/if}
  </button>
</span>
