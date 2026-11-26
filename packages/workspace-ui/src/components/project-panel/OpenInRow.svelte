<script lang="ts">
  import { ChevronDown, Code, Check } from '@lucide/svelte';
  import { getWorkspaceContext, toolsStore } from '../../contexts';
  import { requestInputFocus } from '../../lib/inputFocus';
  import { comboHint } from '../../lib/keybindings/manifest';
  import AppLogo from '../settings/AppLogo.svelte';
  import TerminalAppLogo from '../settings/TerminalAppLogo.svelte';
  import * as DropdownMenu from '../ui/dropdown-menu';
  import MenuRow from './MenuRow.svelte';
  import type { OpenInTarget } from './lib/open-in';
  import { OpenInEditor } from './lib/open-in-editor.svelte';

  let { sourceId, active, openTerminal }: { sourceId: string; active: boolean; openTerminal: () => void } = $props();
  const workspace = getWorkspaceContext();
  const openIn = new OpenInEditor({ get sourceId() { return sourceId; }, get active() { return active; } });
  let menuOpen = $state(false);
  let anchor = $state<HTMLElement | null>(null);

  function open(target: OpenInTarget) {
    if (!openIn.canOpen || !openIn.hasFolder) return;
    if (target === 'terminal') {
      if (openIn.isLocal) openTerminal();
      return;
    }
    // The chosen editor opens every folder of the session that it can hold in one window.
    const paths = target === openIn.target ? openIn.folders.paths : [openIn.workingFolder];
    void openIn.open(target, paths);
  }

  function choose(target: OpenInTarget) {
    openIn.choose(target);
    // The choice changes `openIn.target`, so its folders are the folders of the new editor.
    open(target);
  }
</script>

<div class="flex items-stretch gap-px">
  <MenuRow
    split
    item={{
      key: 'open-in',
      label: openIn.isLoading ? 'Checking applications…' : `Open in ${openIn.editor?.name ?? 'Terminal'}`,
      icon: Code,
      phase: openIn.isLoading ? 'loading' : 'idle',
      disabled: !openIn.canOpen || !openIn.mayOpen(openIn.target) || !openIn.hasFolder || openIn.isLoading,
      hint: openIn.target === 'terminal' ? comboHint('orb.open-terminal') : undefined,
      tooltip: !openIn.canOpen ? 'No SSH target is available for this host' : openIn.foldersTooltip,
    }}
    onInspect={() => { if (active && openIn.target === 'terminal') void toolsStore.refreshResolvedTerminal(workspace.settings.fallbackTerminal); }}
    onActivate={() => open(openIn.target)}
  >
    {#snippet iconSnippet()}
      {#if openIn.editor}
        <AppLogo id={openIn.editor.id} kind="editor" size={16} />
      {:else}
        <TerminalAppLogo size={16} />
      {/if}
    {/snippet}
  </MenuRow>
  <button
    type="button"
    class="inline-flex w-[1.625rem] shrink-0 items-center justify-center rounded-[0.4375rem] text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
    aria-label="Choose application"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    disabled={!openIn.canOpen || !openIn.hasFolder}
    onclick={(event) => {
      anchor = event.currentTarget;
      menuOpen = !menuOpen;
    }}
  >
    <ChevronDown size={11} />
  </button>
</div>
<DropdownMenu.Root bind:open={menuOpen}>
  <DropdownMenu.Content
    customAnchor={anchor?.parentElement ?? anchor}
    side="bottom"
    align="start"
    sideOffset={4}
    alignOffset={0}
    collisionPadding={8}
    onInteractOutside={(event) => {
      if (anchor?.contains(event.target as Node | null)) event.preventDefault();
    }}
    onCloseAutoFocus={(event) => {
      event.preventDefault();
      requestInputFocus();
    }}
  >
    {#if openIn.isLocal}<DropdownMenu.Item role="menuitemradio" aria-checked={openIn.target === 'terminal'} disabled={!openIn.mayOpen('terminal')} onSelect={() => choose('terminal')}>
      <TerminalAppLogo size={16} />
      <span class="min-w-0 flex-1 truncate">Terminal</span>
      {#if openIn.target === 'terminal'}<Check size={16} />{/if}
    </DropdownMenu.Item>{/if}
    {#each openIn.editors as option (option.id)}
      <DropdownMenu.Item role="menuitemradio" aria-checked={openIn.target === option.id} disabled={!openIn.mayOpen(option.id)} onSelect={() => choose(option.id)}>
        <AppLogo id={option.id} kind="editor" size={16} />
        <span class="min-w-0 flex-1 truncate">{option.name}</span>
        {#if openIn.target === option.id}<Check size={16} />{/if}
      </DropdownMenu.Item>
    {/each}
    {#if openIn.tools?.state === 'loading'}
      <DropdownMenu.Item disabled>Checking installed editors…</DropdownMenu.Item>
    {:else if openIn.tools?.state === 'error'}
      <DropdownMenu.Item disabled>Could not load installed editors</DropdownMenu.Item>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
