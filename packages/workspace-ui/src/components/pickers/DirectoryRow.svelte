<script lang="ts">
  import { CornerLeftUp as ArrowElbowLeftUpIcon, Folder as FolderIcon, GitBranch as GitBranchIcon } from "@lucide/svelte";
  import { worktreeDisplayName } from "../../lib/git-context";
  import { MiddleTruncate } from "../ui/middle-truncate";
  import { TouchLongPress } from "../../lib/touch-long-press";

  interface Props {
    id: string;
    name: string;
    /** The ".." row that walks one level up, rendered above the folders. */
    isUpRow?: boolean;
    selected: boolean;
    /** The folder is a git checkout — browsing an unfamiliar host stops being guesswork. */
    isRepo?: boolean;
    /** Checked-out branch, when the host could resolve one. */
    branch?: string;
    /** Solus already knows this folder as a project on this host. */
    isProject?: boolean;
    /** Absolute positioning handed down by the virtual list. */
    style?: string;
    onclick: () => void;
    /** Right-click, or a touch long-press: the phone's way to the same menu. */
    onContextMenu?: (event: MouseEvent) => void;
  }

  let {
    id,
    name,
    isUpRow = false,
    selected,
    isRepo = false,
    branch,
    isProject = false,
    style,
    onclick,
    onContextMenu,
  }: Props = $props();

  const longPress = new TouchLongPress((event) => onContextMenu?.(event));
</script>

<button
  type="button"
  {id}
  {style}
  class="mx-2 flex h-8 w-[calc(100%-1rem)] items-center gap-2.5 rounded-md border-0 px-2.5 text-left
    [transition:background-color_var(--duration-quick)_var(--ease-premium)] motion-reduce:transition-none
    select-none [-webkit-touch-callout:none]
    {selected ? 'bg-muted' : 'bg-transparent hover:bg-muted'}"
  role="option"
  aria-selected={selected}
  tabindex={-1}
  onclick={() => {
    if (!longPress.consumeClick()) onclick();
  }}
  oncontextmenu={(event) => {
    if (!onContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(event);
  }}
  onpointerdown={(event) => longPress.start(event)}
  onpointerup={() => longPress.cancel()}
  onpointercancel={() => longPress.cancel()}
  onpointermove={() => longPress.cancel()}
>
  {#if isUpRow}
    <ArrowElbowLeftUpIcon size={13} class="shrink-0 text-muted-foreground" />
    <span class="flex-1 truncate font-mono text-xs text-muted-foreground">{name}</span>
  {:else}
    <!-- A checkout is the thing you are usually looking for, so it is the one
         row that carries the accent. -->
    {#if isRepo}
      <GitBranchIcon size={13} class="shrink-0 text-primary" />
    {:else}
      <FolderIcon size={13} class="shrink-0 text-muted-foreground" />
    {/if}
    <span class="min-w-0 shrink truncate text-[0.8125rem]">{name}</span>
    {#if branch}
      <MiddleTruncate
        value={worktreeDisplayName(branch)}
        showTitle={false}
        title="On branch {worktreeDisplayName(branch)}"
        class="max-w-[45%] shrink-0 font-mono text-xs text-muted-foreground"
      />
    {/if}
    {#if isProject}
      <!-- A folder Solus already tracks. -->
      <span class="shrink-0 text-xs text-muted-foreground">Project</span>
    {/if}
  {/if}
</button>
