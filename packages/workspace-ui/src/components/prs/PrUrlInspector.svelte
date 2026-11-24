<script lang="ts">
  import { Link as LinkIcon } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import * as Popover from '../ui/popover';
  import { Button } from '../ui/button';
  import { Input } from '../ui/input';
  /** Opens one pull request by its URL in the page's panel. `onOpen` rejects
   *  with the message to show under the field. */
  let { onOpen }: { onOpen: (url: string) => Promise<void> } = $props();
  let url = $state('');
  let pending = $state(false);
  let error = $state<string | null>(null);
  let isOpen = $state(false);
  let request = 0;
  let openedPullRequest = false;
  onDestroy(() => { request++; });

  async function open() {
    if (pending || !url.trim()) return;
    const current = ++request;
    const isCurrent = () => current === request && isOpen;
    pending = true;
    error = null;
    try {
      await onOpen(url.trim());
      if (!isCurrent()) return;
      openedPullRequest = true;
      url = '';
      isOpen = false;
    } catch (cause) {
      if (isCurrent()) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (current === request) pending = false;
    }
  }
</script>

<Popover.Root bind:open={isOpen} onOpenChange={(next) => {
  if (next) return;
  request++;
  pending = false;
  error = null;
}}>
  <Popover.Trigger>
    {#snippet child({ props })}
      <!-- In the Refresh chip's geometry, beside it in the page's head row;
           the label goes first in a narrow pane. -->
      <button
        {...props}
        type="button"
        class="flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-full border-0 bg-transparent pr-[9px] pl-[7px] text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] aria-expanded:bg-[var(--wash-2)] aria-expanded:text-foreground"
        aria-label="Open a PR URL"
        title="Open one pull request by its URL"
      >
        <LinkIcon size={12} class="shrink-0" aria-hidden="true" />
        <span class="truncate text-chrome-shelf @max-[30rem]/pane:hidden">Open PR URL</span>
      </button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content
    data-solus-ui
    side="bottom"
    align="end"
    sideOffset={6}
    collisionPadding={8}
    onCloseAutoFocus={(event) => {
      // The panel that opened takes the reader on; focus stays there.
      if (openedPullRequest) event.preventDefault();
      openedPullRequest = false;
    }}
    class="menu-surface z-[10002] w-[min(30rem,calc(100vw-2rem))] gap-3 rounded-2xl bg-(--solus-menu-bg) p-3 text-workspace-chrome lg:text-workspace-chrome shadow-[shadow:var(--solus-menu-shadow)] ring-0"
  >
    <form
      class="flex items-center gap-2"
      onsubmit={(event) => {
        event.preventDefault();
        void open();
      }}
    >
      <Input
        name="pr-url"
        type="url"
        aria-label="PR URL"
        bind:value={url}
        disabled={pending}
        maxlength={2048}
        class="h-8 min-w-0 flex-1 text-workspace-chrome"
        placeholder="Paste a GitHub pull request URL"
      />
      <Button type="submit" size="sm" class="h-8 text-workspace-chrome" disabled={pending || !url.trim()}>
        {pending ? 'Opening…' : 'Open'}
      </Button>
    </form>
    {#if error}
      <p role="alert" class="m-0 text-xs text-(--failure)">{error}</p>
    {/if}
  </Popover.Content>
</Popover.Root>
