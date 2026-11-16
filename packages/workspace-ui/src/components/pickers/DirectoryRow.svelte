<script lang="ts">
  import FileIcon from "../ui/file-icon/FileIcon.svelte";
  import { Folder as FolderIcon } from "@lucide/svelte";
  import { worktreeDisplayName } from "../../lib/git-context";
  import { MiddleTruncate } from "../ui/middle-truncate";
  import { TouchLongPress } from "../../lib/touch-long-press";

  interface Props {
    id: string;
    name: string;
    selected: boolean;
    /** The folder is a git checkout — browsing an unfamiliar host stops being guesswork. */
    isRepo?: boolean;
    /** Checked-out branch, when the host could resolve one. */
    branch?: string;
    /** The Kind column: what the entry is, in words. */
    kind: string;
    /** A file the picker offers to choose, not a folder. */
    isFile?: boolean;
    /** Absolute positioning handed down by the virtual list. */
    style?: string;
    /** One click with a mouse: the row becomes the selection. */
    onSelect: () => void;
    /** A double-click, or one tap on a touch screen: the row opens. */
    onOpen: () => void;
    /** Right-click, or a touch long-press: the phone's way to the same menu. */
    onContextMenu?: (event: MouseEvent) => void;
  }

  let {
    id,
    name,
    selected,
    isRepo = false,
    branch,
    kind,
    isFile = false,
    style,
    onSelect,
    onOpen,
    onContextMenu,
  }: Props = $props();

  const longPress = new TouchLongPress((event) => onContextMenu?.(event));
  /** A finger has no double-click, so its tap opens the row at once. */
  let pressedByTouch = false;
</script>

<!-- The Branch and Kind widths, and the widths they hide at, mirror the column
     heads in DirectoryPicker. -->
<button
  type="button"
  {id}
  {style}
  class="ml-1.5 mr-2.5 flex h-9 w-[calc(100%-1rem)] items-center gap-4 overflow-hidden rounded-lg border-0 px-2.5 text-left
    [transition:background-color_var(--duration-quick)_var(--ease-premium)] motion-reduce:transition-none
    select-none [-webkit-touch-callout:none]
    {selected ? 'bg-primary/10' : 'bg-transparent hover:bg-muted'}"
  role="option"
  aria-selected={selected}
  tabindex={-1}
  onmousedown={(event) => event.preventDefault()}
  onclick={() => {
    if (longPress.consumeClick()) return;
    if (pressedByTouch) onOpen();
    else onSelect();
  }}
  ondblclick={() => {
    if (!pressedByTouch) onOpen();
  }}
  oncontextmenu={(event) => {
    if (!onContextMenu) return;
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(event);
  }}
  onpointerdown={(event) => {
    pressedByTouch = event.pointerType === "touch";
    longPress.start(event);
  }}
  onpointerup={() => longPress.cancel()}
  onpointercancel={() => longPress.cancel()}
  onpointermove={() => longPress.cancel()}
>
  <span class="flex min-w-0 flex-1 items-center gap-3">
    <!-- A checkout is the thing you are usually looking for, so it is the one
         row that carries the accent. -->
    {#if isRepo}
      <FolderIcon size={16} class="shrink-0 fill-primary/20 text-primary" />
    {:else if isFile}
      <FileIcon path={name} size={16} class="text-muted-foreground" />
    {:else}
      <FolderIcon size={16} class="shrink-0 fill-muted-foreground/15 text-muted-foreground" />
    {/if}
    <span class="min-w-0 truncate text-[0.8125rem]">{name}</span>
  </span>
  <span class="flex w-36 shrink-0 @max-[18rem]/picker:hidden">
    {#if branch}
      <MiddleTruncate
        value={worktreeDisplayName(branch)}
        showTitle={false}
        title="On branch {worktreeDisplayName(branch)}"
        class="font-mono text-xs text-muted-foreground"
      />
    {/if}
  </span>
  <span class="w-28 shrink-0 truncate text-xs text-muted-foreground @max-[26rem]/picker:hidden">{kind}</span>
</button>
