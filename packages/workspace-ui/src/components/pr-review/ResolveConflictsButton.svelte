<script lang="ts">
  import type { IpcContext } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../contexts";
  import { Button } from "../ui/button";

  // Shown in the PR header when the PR conflicts with its base. One button, one
  // job: open a resolver session. startConflictResolverSession opens the new tab
  // immediately (with a live status card while the worktree + merge are prepared),
  // so the click lands in the session right away and this header never morphs.
  let {
    pr,
    getCtx,
  }: {
    pr: { number: number; title: string };
    getCtx: () => IpcContext;
  } = $props();

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
  class="flex h-[34px] w-full cursor-pointer items-center justify-center overflow-hidden rounded-[10px] border-0 bg-(--solus-art-negative) px-3.5 font-medium text-white transition-[background-color,scale] duration-150 hover:bg-[color-mix(in_oklch,var(--solus-art-negative)_88%,var(--foreground))] focus-visible:ring-[color:color-mix(in_srgb,var(--solus-art-negative)_28%,transparent)] active:scale-[0.96]"
  onclick={resolve}
  title="Open an agent session to resolve the merge conflicts"
>
  <span class="truncate">Resolve conflicts</span>
</Button>
