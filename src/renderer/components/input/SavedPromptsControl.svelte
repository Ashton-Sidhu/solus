<script lang="ts">
  import {
    BookmarkSimpleIcon,
    CaretUpIcon,
    XIcon,
    FileTextIcon,
    ImageIcon,
    FileCodeIcon,
    FileIcon,
  } from "phosphor-svelte";
  import type { Component } from "svelte";
  import * as Popover from "@renderer/components/ui/popover";
  import * as Command from "@renderer/components/ui/command";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import MenuSearch from "@renderer/components/ui/menu/menu-search.svelte";
  import MenuFooter from "@renderer/components/ui/menu/menu-footer.svelte";
  import Kbd from "@renderer/components/ui/Kbd.svelte";
  import { getWorkspaceContext, savedPrompts } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { relativeTime } from "../../lib/relative-time";
  import { uuid } from "../../../shared/uuid";
  import type { Prompt, SavedPrompt } from "../../../shared/types";
  import {
    SAVED_PROMPTS_EVENT,
    type SavedPromptsRequest,
  } from "../../lib/savedPromptsRequest";
  import { matchesQuery, promptPreview, thumbnailFor } from "./lib/saved-prompts";

  interface Props {
    /** The unsent message this control saves and restores — handed over rather
     *  than looked up, so it works for a draft that has no tab. */
    prompt: Prompt;
    /** The tab this composer sits in, when it sits in one; only the addressed
     *  saved-prompts shortcut uses it. */
    tabId?: string;
    /** Null in a directory we can't file prompts under — the control disables. */
    projectRoot: string | null;
    /** The host that owns the project and its saved-prompts file. */
    serverId: string | null;
    /** This composer is the one the user is typing in. Gates every binding. */
    active: boolean;
    isReadOnly: boolean;
    /** The composer card, so the sheet can match its width. */
    anchorEl: HTMLElement | null;
    onClearEditor: () => void;
    onRefocus: () => void;
  }
  let {
    prompt: input,
    tabId,
    projectRoot,
    serverId,
    active,
    isReadOnly,
    anchorEl,
    onClearEditor,
    onRefocus,
  }: Props = $props();

  const session = getWorkspaceContext();

  let open = $state(false);
  let query = $state("");
  let selectedId = $state("");
  let triggerEl = $state<HTMLElement | null>(null);

  const prompts = $derived(savedPrompts.forProject(projectRoot, serverId));
  const count = $derived(prompts.length);
  // Every row reserves the thumbnail slot as soon as one row needs it, so the
  // prompt text keeps a single left edge down the list. An all-text list keeps
  // its gutter rather than carrying 44px of nothing on every row.
  const showsThumbnails = $derived(
    prompts.some((prompt) => prompt.attachments.length > 0),
  );
  const hasDraft = $derived(
    input.text.trim().length > 0 || input.attachments.length > 0,
  );
  const canSave = $derived(
    !!projectRoot && !!serverId && !isReadOnly && hasDraft,
  );
  const saveHint = $derived(comboHint("global.save-prompt"));
  const openHint = $derived(comboHint("global.saved-prompts"));

  const emptyMessage = $derived(
    query.trim()
      ? `No saved prompt matches “${query.trim()}”`
      : "No saved prompts in this project yet",
  );

  const FILE_ICON_COMPONENTS = {
    "image/png": ImageIcon,
    "image/jpeg": ImageIcon,
    "image/gif": ImageIcon,
    "image/webp": ImageIcon,
    "image/svg+xml": ImageIcon,
    "text/plain": FileTextIcon,
    "text/markdown": FileTextIcon,
    "application/json": FileCodeIcon,
    "text/yaml": FileCodeIcon,
    "text/toml": FileCodeIcon,
  } satisfies Record<string, Component>;

  // Loading on open rather than on mount: the list is only ever read through
  // this sheet, and re-reading on open is also what keeps a second window's
  // saves from showing up stale.
  $effect(() => {
    if (!open || !projectRoot || !serverId) return;
    void savedPrompts.load(projectRoot, serverId, { force: true });
  });

  $effect(() => {
    if (!projectRoot || !serverId) return;
    void savedPrompts.load(projectRoot, serverId);
  });

  // The sheet belongs to the composer it was opened from; once that composer
  // stops being the focused one the draft target has changed under it.
  $effect(() => {
    if (!active) open = false;
  });

  $effect(() => {
    if (!open) query = "";
  });

  // A draft that has been emptied is no longer the restored prompt, so the send
  // that eventually happens shouldn't delete it. Early-returns on the common
  // unlinked path, so this costs one read per keystroke.
  $effect(() => {
    if (!input.savedPromptId) return;
    if (input.text.trim() === "" && input.attachments.length === 0) {
      input.savedPromptId = null;
    }
  });

  $effect(() => {
    if (!active) return;
    const onRequest = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: SavedPromptsRequest = event.detail;
      if (detail?.tabId && detail.tabId !== tabId) return;
      if (detail?.action === "save") void save();
      else open = true;
    };
    window.addEventListener(SAVED_PROMPTS_EVENT, onRequest);
    return () => window.removeEventListener(SAVED_PROMPTS_EVENT, onRequest);
  });

  async function save() {
    if (!projectRoot || !serverId || !hasDraft || isReadOnly) return;
    const prompt: SavedPrompt = {
      id: uuid(),
      projectRoot,
      text: input.text.trim(),
      attachments: $state.snapshot(input.attachments),
      createdAt: Date.now(),
    };
    const restoreText = input.text;
    const restoreAttachments = $state.snapshot(input.attachments);

    input.text = "";
    input.attachments.splice(0, input.attachments.length);
    input.savedPromptId = null;
    onClearEditor();
    onRefocus();

    try {
      await savedPrompts.create(prompt, serverId);
      toasts.success("Prompt saved");
    } catch (err) {
      // Give the draft back rather than leaving the composer empty and the
      // prompt nowhere — the size guard rejects big attachment sets. Assigning
      // `text` is all it takes; clearing the editor here would blank what we
      // just restored.
      input.text = restoreText;
      input.attachments.splice(0, input.attachments.length, ...restoreAttachments);
      toasts.error("Could not save prompt", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function restore(prompt: SavedPrompt) {
    // Setting `text` is enough: the composer's editor syncs its document from
    // this value, so there is no editor handle to reach for here.
    input.text = prompt.text;
    input.attachments.splice(
      0,
      input.attachments.length,
      ...prompt.attachments.map((attachment) => ({ ...attachment })),
    );
    input.savedPromptId = prompt.id;
    open = false;
    onRefocus();
  }

  function remove(prompt: SavedPrompt) {
    if (!projectRoot || !serverId) return;
    if (input.savedPromptId === prompt.id) input.savedPromptId = null;
    const deleted = savedPrompts.remove(projectRoot, prompt.id, serverId);
    toasts.undo("Saved prompt deleted", () => {
      // Sequenced after the delete so an instant undo can't be overwritten by
      // the delete landing second. Re-created with its original id and
      // timestamp, so it lands back where it was rather than jumping to the top.
      void deleted.then(() => savedPrompts.create(prompt, serverId));
    });
  }

  function deleteSelected() {
    const prompt = prompts.find((p) => p.id === selectedId);
    if (prompt) remove(prompt);
  }

  useScope("saved-prompts", { active: () => open });

  useKeybinding("global.save-prompt", save, {
    enabled: () => active && canSave,
  });
  useKeybinding(
    "global.saved-prompts",
    () => {
      open = !open;
    },
    { enabled: () => active && !!projectRoot },
  );
  // Only while the search field is empty, so ⌫ still deletes a character once
  // the user starts typing.
  useKeybinding("saved-prompts.delete", deleteSelected, {
    enabled: () => open && query.length === 0 && !!selectedId,
  });
</script>

<!--
  Saved prompts: park the draft you aren't ready to send, and get it back later.
  The pill's two halves are one control — save on the left, the count opens the
  sheet on the right — sitting immediately left of the mic/send cluster.
-->
<!-- One shell, two halves, one hairline between them: the bookmark writes the
     draft to the library in place, the label opens it. The toolbar row's gap is
     all the air it needs — it sits with the pickers, not the send cluster. -->
<div
  bind:this={triggerEl}
  class="flex h-[1.875rem] shrink-0 items-center rounded-lg border-[0.5px] border-(--solus-container-border) font-secondary text-(--solus-text-secondary)"
>
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
        <button
          {...tooltipProps}
          type="button"
          onclick={() => (canSave ? save() : (open = true))}
          disabled={!projectRoot}
          aria-label="Save prompt"
          class="flex h-full w-[1.8125rem] items-center justify-center rounded-l-lg text-(--solus-text-tertiary) transition-[background-color,color,scale] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:bg-(--solus-accent-light) focus-visible:outline-none disabled:opacity-50"
          style="cursor:{projectRoot ? 'pointer' : 'not-allowed'}"
        >
          <BookmarkSimpleIcon size={13} class="shrink-0" />
        </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content
      value={!projectRoot
        ? "Open a project to save prompts"
        : `Save prompt (${saveHint})`}
    />
  </TooltipUI.Root>

  <div class="h-4 w-px shrink-0 bg-(--solus-container-border)"></div>

  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
        <button
          {...tooltipProps}
          type="button"
          onclick={() => (open = !open)}
          disabled={!projectRoot}
          aria-label="Saved prompts"
          aria-expanded={open}
          class="flex h-full items-center gap-1.5 rounded-r-lg px-2.5 text-[0.8125rem] text-(--solus-text-tertiary) transition-[background-color,color,scale] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:bg-(--solus-accent-light) focus-visible:outline-none disabled:opacity-50"
          style="cursor:{projectRoot ? 'pointer' : 'not-allowed'}"
        >
          <span>Saved</span>
          <span class="font-mono text-xs tabular-nums opacity-60"
            >{count}</span
          >
          <!-- The caret points at where the sheet appears, and flips while it
               is up. -->
          <CaretUpIcon
            size={9}
            class="shrink-0 transition-transform duration-150 {open
              ? 'rotate-180'
              : ''}"
          />
        </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={`Saved prompts (${openHint})`} />
  </TooltipUI.Root>
</div>

<Popover.Root
  bind:open
  onOpenChange={(next) => {
    if (!next) onRefocus();
  }}
>
  <!-- Anchored to the composer card, not the pill, so the sheet spans the full
       composer — a saved prompt is a paragraph, and reading it in a narrow menu
       column turns it back into a list item. The class list restates
       rounded-2xl/bg/shadow/text-menu for the same reason GitDropdown does:
       Popover.Content's stock rounded-lg + bg-popover + shadow-md are emitted
       after the utility layer and would otherwise win the cascade, and
       lg:text-menu is a separate merge group from the bare text-menu so the
       primitive's lg:text-sm needs answering at its own breakpoint. -->
  <Popover.Content
    data-solus-ui
    customAnchor={anchorEl}
    side="top"
    align="start"
    sideOffset={16}
    collisionPadding={8}
    onInteractOutside={(event) => {
      if (triggerEl?.contains(event.target as Node)) event.preventDefault();
    }}
    class="menu-surface z-[10002] w-[var(--bits-popover-anchor-width)] max-w-[var(--bits-popover-anchor-width)] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-menu lg:text-menu shadow-[shadow:var(--solus-menu-shadow)] ring-0"
  >
    <Command.Root
      bind:value={selectedId}
      filter={(_value, search, keywords) =>
        matchesQuery(keywords?.[0] ?? "", search) ? 1 : 0}
    >
      <MenuSearch bind:value={query} placeholder="Search saved prompts">
        {#snippet trailing()}
          <Kbd variant="hint">esc</Kbd>
        {/snippet}
      </MenuSearch>
      <Command.List class="max-h-[17.5rem] p-1.5">
        <Command.Empty
          class="px-2.5 py-3 text-center text-xs text-(--solus-text-tertiary)"
        >
          {emptyMessage}
          {#if !query.trim()}
            <span class="mt-1 block"
              >Press <Kbd variant="hint">{saveHint}</Kbd> to save the current draft</span
            >
          {/if}
        </Command.Empty>
        <Command.Group>
          {#each prompts as prompt (prompt.id)}
            {@const thumbnail = thumbnailFor(prompt.attachments)}
            <Command.Item
              value={prompt.id}
              keywords={[prompt.text]}
              onSelect={() => restore(prompt)}
              class="group/prompt h-auto gap-3 py-1.5"
            >
              {#if showsThumbnails}
                <span class="relative flex h-7 w-11 shrink-0">
                  {#if !thumbnail}
                    <!-- Placeholder: holds the column so text stays aligned. -->
                  {:else if thumbnail.dataUrl}
                    <img
                      src={thumbnail.dataUrl}
                      alt=""
                      class="h-7 w-11 rounded-md border border-(--solus-container-border) object-cover"
                    />
                  {:else}
                    {@const Icon =
                      FILE_ICON_COMPONENTS[thumbnail.mimeType ?? ""] ?? FileIcon}
                    <span
                      class="flex h-7 w-11 items-center justify-center rounded-md border border-(--solus-container-border) bg-(--solus-surface-hover) text-(--solus-text-tertiary)"
                    >
                      <Icon size={13} />
                    </span>
                  {/if}
                  {#if thumbnail && thumbnail.extra > 0}
                    <span
                      class="absolute -bottom-1 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full border border-(--solus-container-border) bg-(--solus-container-bg) px-1 text-xs font-medium tabular-nums text-(--solus-text-tertiary)"
                      >+{thumbnail.extra}</span
                    >
                  {/if}
                </span>
              {/if}
              <span class="min-w-0 flex-1 truncate"
                >{promptPreview(prompt.text)}</span
              >
              <span
                class="flex shrink-0 items-center gap-2 text-menu-meta text-(--solus-text-tertiary)"
              >
                <span class="whitespace-nowrap">{relativeTime(prompt.createdAt)}</span>
                <!-- Command binds onclick to select, so a bare click here would
                     restore the prompt on its way to deleting it. -->
                <button
                  type="button"
                  aria-label="Delete saved prompt"
                  onclick={(event) => {
                    event.stopPropagation();
                    remove(prompt);
                  }}
                  class="flex h-[1.375rem] w-[1.375rem] cursor-pointer items-center justify-center rounded-md opacity-55 transition-opacity hover:bg-(--solus-surface-hover) hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
                >
                  <XIcon size={11} />
                </button>
              </span>
            </Command.Item>
          {/each}
        </Command.Group>
      </Command.List>
    </Command.Root>
    <MenuFooter
      hints={[
        ["↑↓", "move"],
        ["⏎", "restore prompt + attachments"],
        ["⌫", "delete"],
      ]}
      summary="{count} saved"
    />
  </Popover.Content>
</Popover.Root>
