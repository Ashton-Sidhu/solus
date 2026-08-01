<script lang="ts">
  import { WarningCircleIcon } from "phosphor-svelte";
  import type { IpcContext } from "../../../shared/types";
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
  class="flex h-[30px] w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border bg-transparent px-3.5 text-[12.5px] font-medium text-(--solus-art-negative) transition-colors hover:bg-muted"
  onclick={resolve}
  title="Open an agent session to resolve the merge conflicts"
>
  <WarningCircleIcon size={13} weight="fill" class="shrink-0" />
  Resolve conflicts
</Button>
