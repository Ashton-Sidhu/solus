<script lang="ts">
  import type { IpcContext } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../contexts";
  import { Button } from "../ui/button";
  import type { PrActionsLayout } from "./lib/pr-actions-layout";

  // Shown in the PR header when the PR conflicts with its base. One button, one
  // job: open a resolver session. startConflictResolverSession opens the new tab
  // immediately (with a live status card while the worktree + merge are prepared),
  // so the click lands in the session right away and this header never morphs.
  let {
    pr,
    getCtx,
    layout = "card",
  }: {
    pr: { number: number; title: string };
    getCtx: () => IpcContext;
    /** Full-width inside the rail's status card; content-width in the row the
     *  card becomes once the rail folds. */
    layout?: PrActionsLayout;
  } = $props();

  const row = $derived(layout === "row");

  const session = getWorkspaceContext();

  function resolve() {
    void session.startConflictResolverSession(
      { number: pr.number, title: pr.title },
      { ctx: getCtx() },
    );
  }
</script>

<Button
  type="button"
  class="flex cursor-pointer items-center justify-center overflow-hidden rounded-[10px] border-0 bg-(--solus-art-negative) px-3.5 font-medium text-white transition-[background-color,scale] duration-150 hover:bg-[color-mix(in_oklch,var(--solus-art-negative)_88%,var(--foreground))] focus-visible:ring-[color:color-mix(in_srgb,var(--solus-art-negative)_28%,transparent)] active:scale-[0.96] {row
    ? 'h-8 shrink-0 pointer-fine:[.is-laptop-display_&]:h-7'
    : 'h-[34px] w-full'}"
  onclick={resolve}
  title="Open an agent session to resolve the merge conflicts"
>
  <span class="truncate">Resolve conflicts</span>
</Button>
