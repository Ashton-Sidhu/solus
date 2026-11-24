<script lang="ts">
  import { Input } from "../ui/input";
  import { PLAIN_MEMBER_LINKS_NOTE } from "./lib/worktree-repositories";

  /** The base branch of a new worktree for a working folder that is not a
   *  repository. Such a folder has no branch list, so the person names the
   *  branch: each repository of the task folder starts from it. */
  interface Props {
    /** The base branch the run has, or null while the person named none. */
    baseBranch: string | null;
    onChoose: (branch: string) => void;
  }
  let { baseBranch, onChoose }: Props = $props();

  let draft = $state("");
  // The field shows the run's branch until the person types.
  let isEdited = $state(false);
  const value = $derived(isEdited ? draft : (baseBranch ?? ""));

  function commit() {
    const branch = value.trim();
    if (!branch || branch === baseBranch) return;
    onChoose(branch);
    isEdited = false;
  }
</script>

<div class="flex flex-col gap-1.5 border-t border-(--solus-menu-hairline) px-3 py-2.5">
  <label class="flex items-center gap-2 text-xs text-(--solus-text-secondary)">
    <span class="shrink-0">Base branch</span>
    <Input
      bind:value={
        () => value,
        (next) => {
          draft = next;
          isEdited = true;
        }
      }
      class="h-7 min-w-0 flex-1"
      placeholder="main"
      maxlength={250}
      autocomplete="off"
      spellcheck={false}
      autofocus={!baseBranch}
      aria-invalid={!baseBranch && !value.trim()}
      onblur={commit}
      onSubmit={commit}
    />
  </label>
  {#if !baseBranch}
    <p class="m-0 text-pretty text-xs leading-snug text-(--solus-status-error)">
      A new worktree must have a base branch. With no base branch, the session starts in this folder.
    </p>
  {/if}
  <p class="m-0 text-pretty text-xs leading-snug text-(--solus-text-tertiary)">
    {PLAIN_MEMBER_LINKS_NOTE}
  </p>
</div>
