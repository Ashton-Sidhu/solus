<script lang="ts">
  import { Plus as PlusIcon } from "@lucide/svelte";
  import TaskCommentComposer from "./TaskCommentComposer.svelte";
  import type { TaskTabId } from "./lib/task-tabs";

  /**
   * The foot of the task page.
   *
   * Where the four sections scroll past each other there is one thing to do at
   * the foot of the page: comment. Where only one section is on screen, the
   * move that section is for is the one the thumb should land on. Linked wants
   * a link, Sessions wants a run, and the composer steps aside for it. The
   * composer is hidden rather than unmounted, so a half-written comment
   * survives a trip through the other tabs.
   */
  interface Props {
    /** True where one section is on screen at a time. */
    stacked: boolean;
    tab: TaskTabId;
    /** The provider a comment is posted to, as a person reads it. */
    providerName: string;
    /** The task as a row names it, for the composer's placeholder. */
    taskRef: string;
    onComment: (body: string) => Promise<void>;
    /** Null on a client that cannot start a session. */
    onStartSession: (() => void) | null;
    /** Null on a client that has nothing to link. */
    onOpenPicker: (() => void) | null;
  }

  let { stacked, tab, providerName, taskRef, onComment, onStartSession, onOpenPicker }: Props = $props();

  const tabAction = $derived(stacked && (tab === "linked" || tab === "sessions") ? tab : null);
</script>

<!-- The composer is outside the tabs on purpose: a comment is about the task,
     not about whichever section is on screen, and the input is always
     reachable. -->
<div class="flex items-end gap-2" class:hidden={tabAction !== null}>
  <div class="min-w-0 flex-1">
    <!-- Where the bar is pinned by the page, the composer's own sticky offset
         and scrim are the second copy of a job already done, and they were
         what padded it into a floating card. -->
    <TaskCommentComposer
      onSubmit={onComment}
      {providerName}
      class={stacked ? "static bottom-auto p-0 [background:none]" : undefined}
      compact={stacked}
      placeholder={stacked ? `Comment on ${taskRef}…` : undefined}
    />
  </div>
  {#if stacked && tab === "overview" && onStartSession}
    <button
      type="button"
      class="mb-1 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(24,20,16,.2)] [-webkit-tap-highlight-color:transparent]"
      onclick={onStartSession}
      aria-label="New session"
    >
      <PlusIcon size={18} />
    </button>
  {/if}
</div>

<!-- Linked and Sessions each have one move worth a whole bar. Primary for
     Sessions, because starting a run is the page's own verb; outlined for
     Linked, because attaching something is a reference, not a commitment. -->
{#if tabAction === "sessions" && onStartSession}
  <button
    type="button"
    class="flex h-12 w-full cursor-pointer items-center justify-center gap-[7px] rounded-lg border-0 bg-primary font-semibold tracking-[-0.006em] text-primary-foreground active:opacity-90 [-webkit-tap-highlight-color:transparent]"
    onclick={onStartSession}
  >
    <PlusIcon size={16} />
    New session
  </button>
{:else if tabAction === "linked" && onOpenPicker}
  <button
    type="button"
    class="flex h-12 w-full cursor-pointer items-center justify-center gap-[7px] rounded-lg border-0 bg-transparent font-medium text-foreground shadow-[shadow:var(--elev-ring)] active:bg-[var(--wash-2)] [-webkit-tap-highlight-color:transparent]"
    onclick={onOpenPicker}
  >
    <PlusIcon size={15} />
    Link an item
  </button>
{/if}
