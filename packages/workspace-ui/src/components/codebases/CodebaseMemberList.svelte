<script lang="ts">
  /** The repositories that a host found inside one folder of a codebase: a
   *  name, where it is from the folder, and a mark for a repository that has
   *  no commit and for a submodule. */
  import type { CodebaseMember } from "@solus/contracts/codebases";
  import { GitBranch as RepositoryIcon } from "@lucide/svelte";
  import { ListChip } from "../ui/list-page";
  import { memberName, memberPlace } from "./lib/codebase-view";

  let { members, label }: { members: CodebaseMember[]; label: string } = $props();
</script>

<ul class="flex flex-col gap-1.5" aria-label={label}>
  {#each members as member (member.path)}
    <li class="flex min-w-0 items-center gap-2 text-[13px]">
      <RepositoryIcon size={13} class="shrink-0 text-muted-foreground" aria-hidden="true" />
      <span class="max-w-[50%] shrink-0 truncate font-medium text-foreground">{memberName(member)}</span>
      <span class="min-w-0 truncate font-mono text-xs text-muted-foreground" title={member.path}>{memberPlace(member)}</span>
      {#if !member.hasCommit}
        <span title="A repository with no commit cannot get a worktree."><ListChip chip={{ label: "No commit", tint: "warning" }} /></span>
      {/if}
      {#if member.submodule}
        <span title="A submodule follows its parent repository."><ListChip chip={{ label: "Submodule", tint: "neutral" }} /></span>
      {/if}
    </li>
  {/each}
</ul>
