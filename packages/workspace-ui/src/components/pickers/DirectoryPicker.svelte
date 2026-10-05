<script lang="ts">
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import { fade, fly } from "svelte/transition";
  import { expoOut } from "svelte/easing";
  import { Input } from "../ui/input";
  import { Button } from "../ui/button";
  import {
    Search as MagnifyingGlassIcon,
    Folder as FolderIcon,
    FolderPlus as FolderPlusIcon,
    ChevronRight as CaretRightIcon,
    Eye as EyeIcon,
    EyeOff as EyeSlashIcon,
    HardDrive as DesktopTowerIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import VirtualList from "../ui/list-page/VirtualList.svelte";
  import DirectoryRow from "./DirectoryRow.svelte";
  import DirectoryEditStrip from "./DirectoryEditStrip.svelte";
  import DirectoryPickerMenu from "./DirectoryPickerMenu.svelte";
  import DirectoryPlaces from "./DirectoryPlaces.svelte";
  import { placesFor, type Place } from "./lib/picker-places";
  import { DirectoryEdits } from "./lib/directory-edits.svelte";
  import {
    projectsStore,
    connectionsStore,
    runtime,
  } from "../../contexts";
  import { getPopoverLayer } from "../popoverLayer.svelte";
  import { portal } from "../portal";
  import { blurActiveTextInputOnMobile } from "../../lib/inputFocus";
  import { eventMatches } from "../../lib/keybindings/match";
  import { copyText, toasts } from "../../lib/toasts";
  import { abbreviateHome } from "../../lib/paths";
  import Kbd from "../ui/Kbd.svelte";
  import type { DirectoryEntry } from "@solus/contracts/types";
  import type { HostApi } from "@solus/client-core/host-api";
  import { hostPolicy } from "@solus/client-core/host-policy";
  import {
    appendPathSegment,
    breadcrumbTrail,
    browsePathPlatform,
    browseDirectoryPath,
    browseLeafSegment,
    browseParentPath,
    ensureDirectoryPath,
    hasTrailingSeparator,
    inferFolderName,
    isRootedPath,
    joinBrowsePath,
    resolveRelativePath,
    type BrowsePathPlatform,
  } from "./lib/browse-path";

  interface Props {
    open: boolean;
    onClose: () => void;
    onSelect: (path: string) => void;
    initialPath?: string;
    title?: string;
    actionLabel?: string;
    /**
     * Present ⇒ the picker saves a file rather than choosing a folder: the
     * footer gains an editable name seeded with this, and `onSelect` receives
     * the full file path instead of the directory.
     */
    fileName?: string;
    /** RPC surface of the host being browsed. */
    api: HostApi;
    /** Shown as a chip when browsing a host other than the active server. */
    hostLabel?: string;
    /** The browsed host; keys the shared project store. */
    serverId: string;
  }

  let {
    open = $bindable(),
    onClose,
    onSelect,
    initialPath,
    title = "Choose folder",
    actionLabel = "Select",
    fileName = undefined,
    api: host,
    hostLabel = undefined,
    serverId,
  }: Props = $props();

  const layer = getPopoverLayer();

  /** The typed path is the only selection state; everything below derives from it. */
  let path = $state("");
  let relativeAnchor = $state("");
  let hostPlatform = $state<BrowsePathPlatform>("posix");
  let hostSystem = $state<string | null>(null);
  let hostReady = $state(false);
  let entries = $state<DirectoryEntry[]>([]);
  /** Host-resolved absolute form of `directoryPath`, with `~` already expanded. */
  let resolvedDirectory = $state("");
  /** Host-resolved parent, needed to walk above aliases such as `~`. */
  let resolvedParentDirectory = $state<string | null>(null);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let creating = $state(false);
  let reloadVersion = $state(0);
  let highlightedIndex = $state(-1);
  let showHidden = $state(false);
  let sidebarLocations = $state<Place[]>([]);
  /** File mode only: the name being saved, edited independently of the folder. */
  let nameDraft = $state("");
  let popoverEl: HTMLDivElement | null = $state(null);
  let pathInputEl: HTMLInputElement | HTMLTextAreaElement | null = $state(null);
  let pathBarEl: HTMLElement | null = $state(null);
  let listHeight = $state(0);
  /** Where a right-click or long-press opened the menu; `entry` null means the folder itself. */
  let contextMenu = $state<{ x: number; y: number; entry: DirectoryEntry | null } | null>(null);
  /** The entry a finished edit left behind, highlighted once the reload lands. */
  let pendingHighlightPath: string | null = null;

  const edits = new DirectoryEdits({
    api: () => host,
    directory: () => resolvedDirectory,
    platform: () => hostPlatform,
    siblingNames: () => entries.map((entry) => entry.name),
    onChanged: (landedPath) => {
      pendingHighlightPath = landedPath;
      // Clear the filter so the new or renamed folder is in view.
      path = directoryPath;
      reloadVersion++;
    },
  });

  const directoryPath = $derived(browseDirectoryPath(path, hostPlatform));
  const leaf = $derived(browseLeafSegment(path, hostPlatform));
  /** The directory shown as crumbs; the leaf stays editable text beside them. */
  const crumbs = $derived(breadcrumbTrail(path, hostPlatform));
  const dirEntries = $derived.by(() => {
    const prefix = leaf.toLowerCase();
    const revealHidden = showHidden || leaf.startsWith(".");
    return entries.filter(
      (e) =>
        e.isDir &&
        e.name.toLowerCase().startsWith(prefix) &&
        (revealHidden || !e.name.startsWith(".")),
    );
  });

  const canGoUp = $derived(
    hasTrailingSeparator(path, hostPlatform) &&
      (browseParentPath(path, hostPlatform) !== null ||
        resolvedParentDirectory !== null),
  );
  type Row = { kind: "up" } | { kind: "dir"; entry: DirectoryEntry };
  const rows: Row[] = $derived.by(() => {
    const nextRows: Row[] = dirEntries.map((entry) => ({ kind: "dir", entry }));
    if (canGoUp) nextRows.unshift({ kind: "up" });
    return nextRows;
  });
  const highlightedRow = $derived(rows[highlightedIndex] ?? null);
  const rowKey = (row: Row) => (row.kind === "up" ? ".." : row.entry.path);
  const activeRow = $derived(rows[Math.max(highlightedIndex, 0)]);
  const activeRowKey = $derived(activeRow ? rowKey(activeRow) : null);

  const exactEntry = $derived(
    leaf ? (dirEntries.find((e) => e.name === leaf) ?? null) : null,
  );
  /** The path Enter commits — always host-absolute so the tab's host can act on it. */
  const resolvedPath = $derived.by(() => {
    if (!resolvedDirectory) return resolveRelativePath(path, relativeAnchor, hostPlatform);
    if (!leaf) return resolvedDirectory;
    return exactEntry?.path ?? joinBrowsePath(resolvedDirectory, leaf, hostPlatform);
  });
  /** A path with no matching folder is created on submit instead of rejected. */
  const willCreate = $derived(
    !loading &&
      path.trim().length > 0 &&
      (leaf ? exactEntry === null : !!loadError),
  );
  const savingFile = $derived(fileName !== undefined);
  /** A name of only whitespace, or with separators in it, is not a file name. */
  const trimmedName = $derived(nameDraft.trim());
  const nameIsValid = $derived(
    trimmedName.length > 0 && !trimmedName.includes("/") && !trimmedName.includes("\\"),
  );
  /**
   * Only decidable while the browsed folder *is* the target — a name typed into
   * the filter points at a folder whose contents were never listed. The label
   * stays "Save" there, which is never a lie, just less specific.
   */
  const willReplace = $derived(
    savingFile && !leaf && entries.some((e) => !e.isDir && e.name === trimmedName),
  );
  const submitLabel = $derived.by(() => {
    if (!savingFile) return willCreate ? `Create & ${actionLabel}` : actionLabel;
    if (willCreate) return `Create & ${actionLabel}`;
    return willReplace ? "Replace" : actionLabel;
  });
  const targetName = $derived(inferFolderName(resolvedPath || path, hostPlatform));

  // The name belongs to the file the caller asked to save, so re-opening the
  // picker on a different target starts from that target's name.
  $effect(() => {
    if (!open) return;
    nameDraft = fileName ?? "";
  });

  const shouldAutofocus = $derived(!runtime.shouldSuppressFocus);
  /** Must track DirectoryRow's height — the virtual list positions on this number. */
  const rowHeight = 32;
  const activeDescendant = $derived(
    highlightedRow ? `directory-option-${highlightedIndex}` : undefined,
  );
  const recentProjects = $derived(
    projectsStore.recentProjectsFor(serverId),
  );

  const fileManagerName = $derived(
    hostPlatform === "win32"
      ? "Explorer"
      : hostSystem === "linux"
        ? // The desktop's xdg default — could be Nautilus, Dolphin, Thunar…
          "File Manager"
        : "Finder",
  );
  // The file manager opens on the machine running the handler, so it is only
  // meaningful when the browsed host is this one.
  const canOpenFileManager = $derived(
    hostPolicy.isClientMachine(serverId) && connectionsStore.desktopHandlersAvailable,
  );

  function handleBackdropMousedown(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  $effect(() => {
    if (!open) return;

    const browseApi = host;
    let cancelled = false;
    hostReady = false;
    path = "";
    entries = [];
    resolvedDirectory = "";
    resolvedParentDirectory = null;
    highlightedIndex = -1;
    loadError = null;
    sidebarLocations = [];
    contextMenu = null;
    edits.cancel();

    blurActiveTextInputOnMobile();

    // Focus the filter now, not after the host load resolves: on a remote host
    // that round-trip is slow, and the dialog that handed off focus has already
    // unmounted, so keystrokes would fall on the body until the load lands.
    if (shouldAutofocus) requestAnimationFrame(() => pathInputEl?.focus());

    const recents = projectsStore.loadRecentProjects(serverId);
    void Promise.all([
      browseApi.getServerCapabilities().catch(() => null),
      browseApi.listDirectory("~", true).catch(() => null),
      recents.catch(() => []),
    ]).then(([capabilities, home]) => {
      if (cancelled) return;
      hostSystem = capabilities?.platform ?? null;
      hostPlatform = browsePathPlatform(capabilities?.platform, initialPath);

      sidebarLocations = placesFor(hostPlatform, capabilities, home);

      const seed = initialPath || capabilities?.projectsBaseDirectory || "~";
      relativeAnchor = isRootedPath(seed, hostPlatform)
        ? seed
        : capabilities?.projectsBaseDirectory || "~";
      path = ensureDirectoryPath(seed, hostPlatform);
      hostReady = true;
      if (shouldAutofocus) requestAnimationFrame(() => pathInputEl?.focus());
    });
    return () => {
      cancelled = true;
    };
  });

  // Keyed on the directory only: typing a leaf name filters the loaded entries
  // in place and never re-fetches.
  $effect(() => {
    if (!open || !hostReady || !directoryPath) return;
    const request = resolveRelativePath(directoryPath, relativeAnchor, hostPlatform);
    if (!request) return;
    void reloadVersion;
    const browseApi = host;
    let cancelled = false;
    loading = true;
    loadError = null;
    resolvedParentDirectory = null;
    edits.cancel();
    browseApi
      // Annotated: which folders are checkouts and which Solus already knows is
      // exactly what you can't tell by name on a machine you've never used.
      .listDirectory(request, true, true)
      .then((result) => {
        if (cancelled) return;
        entries = result.entries;
        resolvedDirectory = result.currentPath;
        resolvedParentDirectory = result.parentPath;
        loadError = result.error;
        loading = false;
        const landedPath = pendingHighlightPath;
        pendingHighlightPath = null;
        highlightedIndex = landedPath
          ? rows.findIndex((row) => row.kind === "dir" && row.entry.path === landedPath)
          : -1;
      })
      .catch(() => {
        if (cancelled) return;
        loading = false;
        entries = [];
        loadError = "Couldn’t load this folder. Check the connection and try again.";
      });
    return () => {
      cancelled = true;
    };
  });

  // The crumb trail can outgrow the field, and what matters is always its tail:
  // the folder being browsed and the name being typed next to it.
  $effect(() => {
    void path;
    if (pathBarEl) pathBarEl.scrollLeft = pathBarEl.scrollWidth;
  });

  function navigateTo(next: string) {
    highlightedIndex = -1;
    // A touch user can tap a folder and the footer action before the reactive
    // directory load starts. Block submission now, or the action can commit
    // the previously resolved parent while the path already names its child.
    loading = true;
    path = next;
    if (shouldAutofocus) requestAnimationFrame(() => pathInputEl?.focus());
  }

  /** Typing extends the folder the crumbs point at — unless it carries its own root. */
  function setLeaf(next: string) {
    highlightedIndex = -1;
    // A bare "~" is a root, not a name: land in home instead of filtering for it.
    if (next === "~") path = ensureDirectoryPath("~", hostPlatform);
    else path = isRootedPath(next, hostPlatform) ? next : `${directoryPath}${next}`;
  }

  function navigateUp() {
    if (!hasTrailingSeparator(path, hostPlatform)) return;
    const parent =
      browseParentPath(path, hostPlatform) ?? resolvedParentDirectory;
    if (parent) navigateTo(ensureDirectoryPath(parent, hostPlatform));
  }

  function descend(row: Row) {
    if (row.kind === "up") navigateUp();
    else navigateTo(appendPathSegment(path, row.entry.name, hostPlatform));
  }

  /** In file mode the chosen folder is only half the answer; the name is the rest. */
  function commit(directory: string) {
    onSelect(savingFile ? joinBrowsePath(directory, trimmedName, hostPlatform) : directory);
  }

  async function submit() {
    if (loading || creating || !resolvedPath) return;
    if (savingFile && !nameIsValid) return;
    if (!willCreate) {
      commit(resolvedPath);
      return;
    }
    creating = true;
    try {
      const result = await host.createDirectory(resolvedPath);
      if (result.error) {
        loadError = result.error;
        return;
      }
      commit(result.path);
    } catch {
      loadError = "Couldn’t create this folder. Check the connection and try again.";
    } finally {
      creating = false;
    }
  }

  async function openInFileManager(target = resolvedDirectory) {
    if (!target) return;
    const opened = await host.openInFileManager(target).catch(() => false);
    if (!opened) toasts.error(`Couldn’t open this folder in ${fileManagerName}`);
  }

  function focusFilter() {
    if (shouldAutofocus) requestAnimationFrame(() => pathInputEl?.focus());
  }

  /** A filter that names no folder yet is most likely the name to create. */
  function startNewFolder() {
    contextMenu = null;
    edits.startCreate(willCreate ? leaf : "");
  }

  function openRowMenu(index: number, event: MouseEvent) {
    const item = rows[index];
    highlightedIndex = index;
    contextMenu = { x: event.clientX, y: event.clientY, entry: item.kind === "dir" ? item.entry : null };
  }

  /** Shift+F10 or the menu key: the keyboard's right-click, on the highlighted row. */
  function openMenuFromKeyboard() {
    const rect = document.getElementById(`directory-option-${highlightedIndex}`)?.getBoundingClientRect();
    const anchor = rect ?? pathInputEl?.getBoundingClientRect();
    if (!anchor) return;
    contextMenu = {
      x: anchor.left + 24,
      y: anchor.bottom,
      entry: highlightedRow?.kind === "dir" ? highlightedRow.entry : null,
    };
  }

  async function copyPath(target: string) {
    await copyText(target);
    toasts.success("Path copied", { description: abbreviateHome(target) });
  }

  // Keep Tab focus cycling inside the dialog so keyboard users can't fall
  // through to the page behind the backdrop.
  function trapFocus(e: KeyboardEvent) {
    if (!popoverEl) return;
    const focusable = Array.from(
      popoverEl.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(
      (el) =>
        !el.hasAttribute("disabled") &&
        el.getAttribute("tabindex") !== "-1" &&
        el.offsetParent !== null,
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /** New folder, rename, trash, and the menu key. True when `e` was one of them. */
  function runFolderShortcut(e: KeyboardEvent): boolean {
    if (eventMatches(e, { code: "KeyN", alt: true })) startNewFolder();
    else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) openMenuFromKeyboard();
    // Only on a highlighted folder: otherwise ⌘⌫ is still line-delete in the filter.
    else if (highlightedRow?.kind !== "dir") return false;
    else if (e.key === "F2") edits.startRename(highlightedRow.entry);
    else if (eventMatches(e, { code: "Backspace", mod: true })) edits.startTrash(highlightedRow.entry);
    else return false;
    return true;
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Tab") {
      trapFocus(e);
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }

    if (runFolderShortcut(e)) {
      e.preventDefault();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (highlightedRow && !(e.metaKey || e.ctrlKey)) descend(highlightedRow);
      else void submit();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (rows.length > 0) {
        highlightedIndex = Math.min(highlightedIndex + 1, rows.length - 1);
      }
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length > 0) highlightedIndex = Math.max(highlightedIndex - 1, 0);
      return;
    }

    if (e.key === "ArrowRight") {
      if (!highlightedRow) return;
      e.preventDefault();
      descend(highlightedRow);
      return;
    }

    // ← / Backspace walk the tree only at a directory boundary; mid-name they
    // are ordinary text editing on the path input.
    if ((e.key === "ArrowLeft" || e.key === "Backspace") && hasTrailingSeparator(path, hostPlatform)) {
      e.preventDefault();
      navigateUp();
    }
  }
</script>

{#if open && layer.el}
  <!-- Pickers centre in the app window. -->
  <div
    use:portal={layer.el}
    class="fixed inset-0 z-[200] flex items-center justify-center overflow-hidden overscroll-contain bg-black/12"
    role="presentation"
    onmousedown={handleBackdropMousedown}
    transition:fade={{ duration: 120 }}
  >
    <div
      bind:this={popoverEl}
      id="directory-picker"
      class="flex h-[clamp(28rem,65vh,43rem)] w-[clamp(42rem,72vw,64rem)] max-w-full origin-top flex-col overflow-hidden overscroll-contain
        rounded-2xl bg-popover text-foreground
        shadow-[0_1.5rem_4rem_-1rem_rgba(28,22,15,0.34),0_0.0625rem_0.1875rem_rgba(28,22,15,0.10)]
        dark:shadow-[0_1.5rem_4rem_-1rem_rgba(0,0,0,0.55),inset_0_0_0_0.0625rem_var(--border)]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="directory-picker-title"
      tabindex="-1"
      onkeydown={handleKeyDown}
      transition:fly={{ y: 10, duration: 220, easing: expoOut }}
    >
      <header class="flex h-14 shrink-0 items-center gap-3 px-5">
        <div class="flex min-w-0 flex-1 items-center gap-3">
          <span id="directory-picker-title" class="min-w-0 flex-1 truncate text-workspace-chrome font-medium">
            {title}
          </span>
          {#if hostLabel}
            <span class="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground">
              <DesktopTowerIcon size={14} />
              {hostLabel}
            </span>
          {/if}
          <Button
            variant="ghost"
            size="icon-xs"
            class="-mr-1.5 text-muted-foreground"
            onclick={onClose}
            aria-label="Cancel"
          >
            <XIcon size={14} />
          </Button>
        </div>
      </header>

      <div class="flex min-h-0 flex-1">
        <DirectoryPlaces
          locations={sidebarLocations}
          recents={recentProjects.slice(0, 6).map((project) => ({
            label: project.folderName,
            path: ensureDirectoryPath(project.path, hostPlatform),
          }))}
          activePath={path}
          onNavigate={navigateTo}
        />

        <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <!-- Trail on top, filter under it: the trail says where the list is,
               the filter says what is being narrowed inside it. -->
          <div class="shrink-0 px-4 pb-2 pt-3">
            <nav
              bind:this={pathBarEl}
              class="crumb-strip flex items-center gap-[0.1875rem] overflow-x-auto pb-2"
              aria-label="Path breadcrumbs"
            >
              {#each crumbs as crumb, i (crumb.path)}
                {#if i > 0}
                  <CaretRightIcon size={14} class="shrink-0 text-muted-foreground/60" />
                {/if}
                <!-- Kept out of the tab order: the trail is walked with ← and
                     Backspace from the filter, which never loses focus. -->
                <button
                  type="button"
                  tabindex={-1}
                  class="min-h-5 shrink-0 whitespace-nowrap rounded-[0.3125rem] px-1 font-mono text-xs outline-none
                    hover:bg-muted
                    {i === crumbs.length - 1
                      ? 'font-medium'
                      : 'text-muted-foreground'}"
                  onmousedown={(e) => e.preventDefault()}
                  onclick={() => navigateTo(crumb.path)}
                  title={crumb.path}
                >
                  {crumb.label}
                </button>
              {/each}
            </nav>

            <!-- The shell of ui/search-field, restated because this input is a
                 combobox that field cannot carry. -->
            <div
              class="flex h-8 items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--solus-container-border)_60%,transparent)] bg-transparent px-2.5
                transition-[border-color] duration-100 ease-in-out focus-within:border-[color-mix(in_srgb,var(--solus-accent)_45%,transparent)]"
            >
              {#if willCreate}
                <FolderPlusIcon size={14} weight="fill" class="shrink-0 text-primary" />
              {:else}
                <MagnifyingGlassIcon size={14} class="shrink-0 text-(--solus-text-tertiary)" />
              {/if}
              <Input
                bind:ref={pathInputEl}
                value={leaf}
                type="text"
                class="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-[0.8125rem] text-foreground shadow-none focus-visible:ring-0 dark:bg-transparent"
                placeholder="Filter folders"
                spellcheck={false}
                autocomplete="off"
                autocapitalize="off"
                dictation={false}
                role="combobox"
                aria-label="Folder path"
                aria-autocomplete="list"
                aria-controls="directory-picker-list"
                aria-expanded={!loading && !loadError}
                aria-activedescendant={activeDescendant}
                oninput={(e) => setLeaf(e.currentTarget.value)}
              />
              <Button
                variant="ghost"
                size="icon-xs"
                tabindex={-1}
                class="-mr-1 size-5 shrink-0 rounded text-muted-foreground {showHidden ? '' : 'opacity-55'}"
                onmousedown={(e) => e.preventDefault()}
                onclick={() => (showHidden = !showHidden)}
                title={showHidden ? "Hide hidden folders" : "Show hidden folders"}
                aria-label={showHidden ? "Hide hidden folders" : "Show hidden folders"}
                aria-pressed={showHidden}
              >
                {#if showHidden}<EyeSlashIcon size={14} />{:else}<EyeIcon size={14} />{/if}
              </Button>
            </div>
            <DirectoryEditStrip {edits} onSettled={focusFilter} />
          </div>

          <div
            class="virtual-scroll min-h-0 flex-1 overflow-hidden pb-2 [overscroll-behavior-y:contain]"
            bind:clientHeight={listHeight}
            id="directory-picker-list"
            role="listbox"
            aria-label="Folders"
            tabindex={-1}
            oncontextmenu={(e) => {
              e.preventDefault();
              contextMenu = { x: e.clientX, y: e.clientY, entry: null };
            }}
          >
            {#snippet row(index: number, style?: string)}
              {@const item = rows[index]}
              <DirectoryRow
                id={`directory-option-${index}`}
                name={item.kind === "up" ? ".." : item.entry.name}
                isUpRow={item.kind === "up"}
                selected={index === highlightedIndex}
                isRepo={item.kind === "dir" && item.entry.isRepo}
                branch={item.kind === "dir" ? item.entry.branch : undefined}
                isProject={item.kind === "dir" && item.entry.isProject}
                {style}
                onclick={() => descend(item)}
                onContextMenu={(event) => openRowMenu(index, event)}
              />
            {/snippet}

            {#if loading}
              <div
                class="flex h-full flex-col items-center justify-center gap-2"
                role="status"
                aria-live="polite"
              >
                <ContentSkeleton label="Loading folders" />
              </div>
            {:else if loadError}
              <div
                class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
                role="alert"
              >
                <FolderIcon size={20} class="text-(--solus-status-error)" />
                <span class="text-pretty text-xs text-(--solus-text-tertiary)">{loadError}</span>
                {#if willCreate}
                  <span class="text-pretty text-xs text-(--solus-text-tertiary)">
                    Press <Kbd variant="hint">↵</Kbd> to create “{targetName}”.
                  </span>
                {/if}
                <div class="flex items-center gap-2">
                  {#if canGoUp}
                    <Button variant="ghost" onclick={navigateUp}>Go up</Button>
                  {/if}
                  <Button variant="ghost" onclick={() => reloadVersion++}>Retry</Button>
                </div>
              </div>
            {:else if willCreate && rows.length === 0}
              <div
                class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
              >
                <FolderPlusIcon size={20} class="text-(--solus-text-muted)" />
                <span class="text-pretty text-xs text-(--solus-text-tertiary)">
                  Press <Kbd variant="hint">↵</Kbd> to create “{targetName}” and {actionLabel.toLowerCase()} it.
                </span>
              </div>
            {:else if rows.length === 0}
              <div
                class="flex h-full flex-col items-center justify-center gap-2"
              >
                <FolderIcon size={20} class="text-(--solus-text-muted)" />
                <span class="text-xs text-(--solus-text-tertiary)">
                  {leaf ? "No matching folders" : "Empty"}
                </span>
              </div>
            {:else if listHeight > 0}
              <!-- With nothing highlighted the first row is the active one, so a
                   new listing starts at its top. -->
              <VirtualList
                items={rows}
                height={listHeight}
                itemSize={() => rowHeight}
                keyOf={rowKey}
                activeKey={activeRowKey}
                overscan={5}
                showScrollbar
              >
                {#snippet children(_item, index, style)}
                  {@render row(index, style)}
                {/snippet}
              </VirtualList>
            {/if}
          </div>
        </div>
      </div>

      <footer class="flex h-14 shrink-0 items-center gap-3 border-t border-border px-4">
        <!-- The same in open and save mode: making a folder is part of
             choosing one, whatever the picker is for. -->
        <Button
          variant="ghost"
          class="shrink-0 gap-1.5 text-[0.8125rem] text-muted-foreground"
          disabled={loading || !resolvedDirectory}
          onmousedown={(e) => e.preventDefault()}
          onclick={startNewFolder}
          title="New folder (⌥N)"
        >
          <FolderPlusIcon size={14} />
          New folder
        </Button>
        {#if savingFile}
          <!-- The name of the file, not a filter: the crumbs above already say
               which folder it lands in, so this replaces the path readout. -->
          <label class="flex min-w-0 flex-1 items-center gap-2">
            <span class="shrink-0 text-xs text-muted-foreground">Name</span>
            <Input
              bind:value={nameDraft}
              type="text"
              class="h-8 min-w-0 flex-1 text-[0.8125rem]"
              placeholder="File name"
              spellcheck={false}
              autocomplete="off"
              autocapitalize="off"
              dictation={false}
              aria-label="File name"
              aria-invalid={!nameIsValid}
              onkeydown={(e) => {
                // The dialog's own handler treats ↑↓←/Backspace as folder
                // navigation, which would eat ordinary text editing here.
                e.stopPropagation();
                if (e.key === "Escape") onClose();
                if (e.key !== "Enter") return;
                e.preventDefault();
                void submit();
              }}
            />
          </label>
        {:else}
          <div class="flex-1"></div>
        {/if}
        {#if canOpenFileManager}
          <Button
            variant="ghost"
            class="shrink-0 text-[0.8125rem] text-muted-foreground"
            disabled={loading || !resolvedDirectory}
            onclick={() => void openInFileManager()}
          >
            Open in {fileManagerName}
          </Button>
        {/if}
        <Button variant="ghost" class="shrink-0 text-[0.8125rem]" onclick={onClose}>Cancel</Button>
        <Button
          class="shrink-0 px-3.5 text-[0.8125rem]"
          disabled={loading || creating || !resolvedPath || (savingFile && !nameIsValid)}
          onclick={() => void submit()}
        >
          {creating ? "Creating" : submitLabel}
          <!-- In file mode the name is right there in the field beside it. -->
          {#if !savingFile}
            <span class="inline-block max-w-36 truncate align-bottom">“{targetName}”</span>
          {/if}
        </Button>
      </footer>
    </div>
  </div>
  {#if contextMenu}
    {@const menu = contextMenu}
    <DirectoryPickerMenu
      x={menu.x}
      y={menu.y}
      entry={menu.entry}
      fileManagerName={canOpenFileManager ? fileManagerName : null}
      portalTarget={layer.el}
      onNewFolder={startNewFolder}
      onRename={(entry) => edits.startRename(entry)}
      onTrash={(entry) => edits.startTrash(entry)}
      onCopyPath={() => void copyPath(menu.entry?.path ?? resolvedDirectory)}
      onOpenInFileManager={() => void openInFileManager(menu.entry?.path)}
      onClose={() => {
        contextMenu = null;
        // An edit that just opened takes focus itself; anything else returns to the filter.
        if (!edits.edit) focusFilter();
      }}
    />
  {/if}
{/if}

<style>
  /* The virtual list renders its scroller outside this component. A drag on a
     folder list only ever means scroll. */
  .virtual-scroll :global([data-virtual-list]) {
    touch-action: pan-y;
  }

  /* The trail auto-scrolls to its tail on every path change, so a bar under it
     would only eat into the row's height — it is swiped instead. */
  .crumb-strip {
    scrollbar-width: none;
    touch-action: pan-x;
  }
  .crumb-strip::-webkit-scrollbar {
    display: none;
  }
</style>
