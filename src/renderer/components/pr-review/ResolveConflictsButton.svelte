<script lang="ts">
  import { WarningCircleIcon } from "phosphor-svelte";
  import type { IpcContext } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
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
  class="flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border-0 bg-[color:color-mix(in_srgb,var(--solus-art-negative)_12%,transparent)] px-3 text-[0.8125rem] font-semibold text-(--solus-art-negative) transition-[background-color,scale] duration-100 hover:bg-[color:color-mix(in_srgb,var(--solus-art-negative)_18%,transparent)] active:scale-[0.98]"
  onclick={resolve}
  title="Open an agent session to resolve the merge conflicts"
>
  <WarningCircleIcon size={13} weight="fill" class="shrink-0" />
  Resolve conflicts
</Button>
