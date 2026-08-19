<script lang="ts">
  import { fade, fly } from "svelte/transition";
  import { expoOut } from "svelte/easing";
  import { Input } from "../ui/input";
  import { Button } from "../ui/button";
  import {
    MagnifyingGlassIcon,
    FolderIcon,
    FolderPlusIcon,
    HouseIcon,
    CaretRightIcon,
    ClockCounterClockwiseIcon,
    EyeIcon,
    EyeSlashIcon,
    DesktopTowerIcon,
    XIcon,
  } from "phosphor-svelte";
  import VirtualList from "svelte-tiny-virtual-list";
  import DirectoryRow from "./DirectoryRow.svelte";
  import {
    projectsStore,
    connectionsStore,
    serversStore,
    runtime,
  } from "../../contexts";
  import { getPopoverLayer } from "../popoverLayer.svelte";
  import { portal } from "../portal";
  import { blurActiveTextInputOnMobile } from "../../lib/inputFocus";
  import { abbreviateHome } from "../../lib/paths";
  import Kbd from "../ui/Kbd.svelte";
  import WorkspaceMark from "../ui/WorkspaceMark.svelte";
  import type { DirectoryEntry, RecentProject } from "../../../shared/types";
  import type { HostApi } from "@client-core/host-api";
  import { serverConnections } from "@client-core/server-connections";
  import { hostPolicy } from "@client-core/host-policy";
  import {
    centringPadding,
    observeConversationBounds,
    type ConversationBounds,
  } from "./lib/conversation-bounds";
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
    /** The browsed host; also keys the host store's temporary-connection recents cache. */
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

  /** Glyph a Places row carries — what kind of location it is, not its label. */
  type PlaceIcon = "workspace" | "home" | "folder" | "recent";

  const layer = getPopoverLayer();

  // Recents in Places: the client machine's own recent projects when browsing
  // its local host; any other host — including every host on web, where the
  // client machine is not a host — reads that host's recents remotely.
  const isLocalHost = $derived(serverId === serverConnections.localServerId());

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
  /** Kept apart from `loadError` so a failed reveal never hides the folder list. */
  let fileManagerError = $state<string | null>(null);
  let creating = $state(false);
  let reloadVersion = $state(0);
  let highlightedIndex = $state(-1);
  let showHidden = $state(false);
  let remoteRecents = $state<RecentProject[]>([]);
  let sidebarLocations = $state<
    Array<{ label: string; path: string; icon: PlaceIcon }>
  >([]);
  /** File mode only: the name being saved, edited independently of the folder. */
  let nameDraft = $state("");
  let popoverEl: HTMLDivElement | null = $state(null);
  let pathInputEl: HTMLInputElement | HTMLTextAreaElement | null = $state(null);
  let pathBarEl: HTMLElement | null = $state(null);
  let listHeight = $state(0);
  let viewportWidth = $state(0);
  let conversationBounds = $state<ConversationBounds | null>(null);

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

  /** Footer readout: what Enter commits, in the shorthand the user typed it in. */
  const displayPath = $derived(abbreviateHome(resolvedPath || path));

  // The name belongs to the file the caller asked to save, so re-opening the
  // picker on a different target starts from that target's name.
  $effect(() => {
    if (!open) return;
    nameDraft = fileName ?? "";
  });

  const shouldAutofocus = $derived(!runtime.shouldSuppressFocus);
  /** Must track DirectoryRow's height — the virtual list positions on this number. */
  const rowHeight = $derived(runtime.isMobileViewport ? 48 : 32);
  const activeDescendant = $derived(
    highlightedRow ? `directory-option-${highlightedIndex}` : undefined,
  );
  /** Empty on mobile — the sheet is full-width — and wherever there is no column. */
  const centringStyle = $derived(
    runtime.isMobileViewport ? "" : centringPadding(conversationBounds, viewportWidth),
  );

  const recentProjects = $derived(
    isLocalHost ? projectsStore.recentProjects : remoteRecents,
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
    hostPolicy.isClientMachine(serverId) &&
      connectionsStore.desktopHandlersAvailable &&
      !runtime.isMobileViewport,
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

    blurActiveTextInputOnMobile();

    // Focus the filter now, not after the host load resolves: on a remote host
    // that round-trip is slow, and the dialog that handed off focus has already
    // unmounted, so keystrokes would fall on the body until the load lands.
    if (shouldAutofocus) requestAnimationFrame(() => pathInputEl?.focus());

    const recents = isLocalHost
      ? projectsStore.loadRecentProjects().then(() => projectsStore.recentProjects)
      : serversStore.recentProjectsFor(serverId);
    void Promise.all([
      browseApi.getServerCapabilities().catch(() => null),
      browseApi.listDirectory("~", true).catch(() => null),
      recents.catch(() => []),
    ]).then(([capabilities, home, loadedRecents]) => {
      if (cancelled) return;
      hostSystem = capabilities?.platform ?? null;
      hostPlatform = browsePathPlatform(capabilities?.platform, initialPath);
      remoteRecents = loadedRecents;

      const homePath = ensureDirectoryPath("~", hostPlatform);
      const standardNames = ["Desktop", "Documents", "Downloads"];
      const projectsPath = capabilities?.projectsBaseDirectory
        ? ensureDirectoryPath(capabilities.projectsBaseDirectory, hostPlatform)
        : null;
      const resolvedHomePath = home?.currentPath
        ? ensureDirectoryPath(home.currentPath, hostPlatform)
        : homePath;
      const filesystemRoot = breadcrumbTrail(
        resolvedHomePath,
        hostPlatform,
      )[0]?.path;
      // My Workspace pins to the top: it is the app's default working directory,
      // always present on the host, and never surfaces in recents.
      const workspaceLocation = capabilities?.workspacePath
        ? {
            label: "My Workspace",
            path: ensureDirectoryPath(capabilities.workspacePath, hostPlatform),
            icon: "workspace" as const,
          }
        : null;
      sidebarLocations = [
        ...(workspaceLocation ? [workspaceLocation] : []),
        ...(projectsPath && projectsPath !== homePath && projectsPath !== resolvedHomePath
          ? [{ label: "Projects", path: projectsPath, icon: "folder" as const }]
          : []),
        { label: "Home", path: homePath, icon: "home" as const },
        ...(filesystemRoot &&
        filesystemRoot !== homePath &&
        filesystemRoot !== resolvedHomePath
          ? [
              {
                label: hostPlatform === "win32" ? filesystemRoot : "Root",
                path: filesystemRoot,
                icon: "folder" as const,
              },
            ]
          : []),
        ...standardNames
          .filter((name) => home?.entries.some((entry) => entry.isDir && entry.name === name))
          .map((name) => ({
            label: name,
            path: appendPathSegment(homePath, name, hostPlatform),
            icon: "folder" as const,
          })),
      ];

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

  $effect(() => {
    if (!open) return;
    return observeConversationBounds((bounds) => (conversationBounds = bounds));
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
    fileManagerError = null;
    resolvedParentDirectory = null;
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
        highlightedIndex = -1;
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

  async function openInFileManager() {
    if (!resolvedDirectory) return;
    const opened = await host.openInFileManager(resolvedDirectory).catch(() => false);
    fileManagerError = opened ? null : `Couldn’t open this folder in ${fileManagerName}.`;
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

<svelte:window bind:innerWidth={viewportWidth} />

{#if open && layer.el}
  <!-- The scrim covers the window, but its centring box is padded down to the
       conversation column so the dialog lands on the conversation's axis. -->
  <div
    use:portal={layer.el}
    class="fixed inset-0 z-[200] flex items-center justify-center overflow-hidden overscroll-contain bg-black/12
      max-md:bottom-auto max-md:h-[100dvh] max-md:items-end"
    style={centringStyle}
    role="presentation"
    onmousedown={handleBackdropMousedown}
    transition:fade={{ duration: 120 }}
  >
    <div
      bind:this={popoverEl}
      id="directory-picker"
      class="flex w-[clamp(35rem,64vw,56rem)] max-w-full h-[clamp(21.25rem,50vh,36.25rem)] origin-top flex-col overflow-hidden overscroll-contain
        rounded-2xl bg-popover text-foreground
        shadow-[0_1.5rem_4rem_-1rem_rgba(28,22,15,0.34),0_0.0625rem_0.1875rem_rgba(28,22,15,0.10)]
        dark:shadow-[0_1.5rem_4rem_-1rem_rgba(0,0,0,0.55),inset_0_0_0_0.0625rem_var(--border)]
        max-md:mt-auto max-md:h-[90dvh] max-md:w-full max-md:rounded-b-none max-md:rounded-t-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="directory-picker-title"
      tabindex="-1"
      onkeydown={handleKeyDown}
      transition:fly={{ y: 10, duration: 220, easing: expoOut }}
    >
      <header class="flex h-14 shrink-0 items-center gap-3 px-5 max-md:h-auto max-md:px-4 max-md:pb-2 max-md:pt-3">
        <span id="directory-picker-title" class="min-w-0 flex-1 truncate text-workspace-chrome font-medium ">
          {title}
        </span>
        {#if hostLabel}
          <span class="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground">
            <DesktopTowerIcon size={14} />
            {hostLabel}
          </span>
        {/if}
        <Button variant="ghost" size="icon-xs" class="-mr-1.5 text-muted-foreground" onclick={onClose} aria-label="Cancel">
          <XIcon size={14} />
        </Button>
      </header>

      <div class="flex min-h-0 flex-1 max-md:flex-col">
        <nav
          class="places-rail flex w-49 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-r-border p-2
            max-md:flex max-md:w-full max-md:flex-row max-md:gap-1.5 max-md:overflow-x-auto max-md:overflow-y-hidden
            max-md:border-r-0 max-md:border-b max-md:border-b-(--solus-popover-border)/30 max-md:bg-transparent max-md:px-3 max-md:py-2
            max-md:[touch-action:pan-x] max-md:[-webkit-overflow-scrolling:touch]"
          aria-label="Places"
        >
          {#snippet place(label: string, target: string, icon: PlaceIcon)}
            <button
              type="button"
              class="flex h-[1.875rem] w-full shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left text-[0.8125rem] outline-none
                [transition:background-color_var(--duration-quick)_var(--ease-premium),color_var(--duration-quick)_var(--ease-premium)] motion-reduce:transition-none
                focus-visible:ring-2 focus-visible:ring-(--solus-accent)
                max-md:h-9 max-md:w-auto max-md:whitespace-nowrap max-md:rounded-full max-md:px-3.5 max-md:text-xs
                {path === target
                  ? 'bg-secondary text-primary'
                  : icon === 'recent'
                    ? 'text-muted-foreground hover:bg-muted'
                    : 'hover:bg-muted'}"
              onclick={() => navigateTo(target)}
              title={target}
            >
              {#if icon === "workspace"}
                <WorkspaceMark class="size-3.5 shrink-0" />
              {:else if icon === "home"}
                <HouseIcon size={14} class="shrink-0" />
              {:else if icon === "recent"}
                <ClockCounterClockwiseIcon size={14} class="shrink-0" />
              {:else}
                <FolderIcon size={14} class="shrink-0" />
              {/if}
              <span class="truncate">{label}</span>
            </button>
          {/snippet}

          {#each sidebarLocations as loc (loc.path)}
            {@render place(loc.label, loc.path, loc.icon)}
          {/each}

          <div class="my-2 h-px shrink-0 bg-border max-md:my-0 max-md:h-5 max-md:w-px max-md:self-center"></div>

          {#each recentProjects.slice(0, 6) as project (project.path)}
            {@render place(project.folderName, ensureDirectoryPath(project.path, hostPlatform), "recent")}
          {/each}
        </nav>

        <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <!-- Trail on top, filter under it: the trail says where the list is,
               the filter says what is being narrowed inside it. -->
          <div class="shrink-0 px-4 pb-2 pt-3">
            <nav
              bind:this={pathBarEl}
              class="crumb-strip flex items-center gap-[0.1875rem] overflow-x-auto pb-2 max-md:gap-1"
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
                    hover:bg-muted max-md:min-h-8 max-md:px-2 max-md:text-[0.8125rem]
                    {i === crumbs.length - 1 ? 'font-medium' : 'text-muted-foreground'}"
                  onmousedown={(e) => e.preventDefault()}
                  onclick={() => navigateTo(crumb.path)}
                  title={crumb.path}
                >
                  {crumb.label}
                </button>
              {/each}
            </nav>

            <!-- A soft pill rather than a bare row: icon, text and the hidden
                 folder toggle read as one object instead of three loose parts. -->
            <div class="flex h-8 items-center gap-2 rounded-lg bg-muted px-2.5 max-md:h-10">
              {#if willCreate}
                <FolderPlusIcon size={14} weight="fill" class="shrink-0 text-primary" />
              {:else}
                <MagnifyingGlassIcon size={14} class="shrink-0 text-muted-foreground" />
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
                class="size-5 shrink-0 rounded text-muted-foreground hover:bg-card max-md:size-8 {showHidden ? '' : 'opacity-55'}"
                onmousedown={(e) => e.preventDefault()}
                onclick={() => (showHidden = !showHidden)}
                title={showHidden ? "Hide hidden folders" : "Show hidden folders"}
                aria-label={showHidden ? "Hide hidden folders" : "Show hidden folders"}
                aria-pressed={showHidden}
              >
                {#if showHidden}<EyeSlashIcon size={14} />{:else}<EyeIcon size={14} />{/if}
              </Button>
            </div>
          </div>

          <div
            class="virtual-scroll min-h-0 flex-1 overflow-hidden pb-2 [overscroll-behavior-y:contain]"
            bind:clientHeight={listHeight}
            id="directory-picker-list"
            role="listbox"
            aria-label="Folders"
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
              />
            {/snippet}

            {#if loading}
              <div class="flex h-full flex-col items-center justify-center gap-2" role="status" aria-live="polite">
                <span class="text-xs text-(--solus-text-tertiary)">Loading folders…</span>
              </div>
            {:else if loadError}
              <div class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" role="alert">
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
              <div class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                <FolderPlusIcon size={20} class="text-(--solus-text-muted)" />
                <span class="text-pretty text-xs text-(--solus-text-tertiary)">
                  Press <Kbd variant="hint">↵</Kbd> to create “{targetName}” and {actionLabel.toLowerCase()} it.
                </span>
              </div>
            {:else if rows.length === 0}
              <div class="flex h-full flex-col items-center justify-center gap-2">
                <FolderIcon size={20} class="text-(--solus-text-muted)" />
                <span class="text-xs text-(--solus-text-tertiary)">{leaf ? "No matching folders" : "Empty"}</span>
              </div>
            {:else if runtime.isMobileViewport}
              <div class="h-full overflow-y-auto [-webkit-overflow-scrolling:touch] [overscroll-behavior-y:contain] [touch-action:pan-y]">
                {#each rows as _item, index (index)}
                  {@render row(index)}
                {/each}
              </div>
            {:else if listHeight > 0}
              <VirtualList
                width="100%"
                height={listHeight}
                itemCount={rows.length}
                itemSize={rowHeight}
                scrollToIndex={Math.max(highlightedIndex, 0)}
                scrollToAlignment="auto"
                scrollToBehaviour="instant"
                overscanCount={5}
              >
                {#snippet item({ index, style }: { index: number; style: string })}
                  {@render row(index, style)}
                {/snippet}
              </VirtualList>
            {/if}
          </div>
        </div>
      </div>

      <footer class="flex h-14 shrink-0 items-center gap-3 border-t border-border px-4
        max-md:h-auto max-md:flex-wrap max-md:gap-2 max-md:py-2.5 max-md:pb-[max(0.625rem,env(safe-area-inset-bottom,0))]">
        {#if savingFile}
          <!-- The name of the file, not a filter: the crumbs above already say
               which folder it lands in, so this replaces the path readout. -->
          <label class="flex min-w-0 flex-1 items-center gap-2 max-md:order-first max-md:basis-full">
            <span class="shrink-0 text-xs text-muted-foreground">Name</span>
            <Input
              bind:value={nameDraft}
              type="text"
              class="h-8 min-w-0 flex-1 text-[0.8125rem] max-md:h-10"
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
        {:else if fileManagerError}
          <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground max-md:hidden">{fileManagerError}</span>
        {:else}
          <!-- What Enter commits, spelled out — the typed path can be a prefix,
               a "~", or a folder about to be created. -->
          <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground max-md:hidden" title={resolvedPath}>
            {displayPath}
          </span>
          <div class="flex shrink-0 items-center gap-3 text-xs text-muted-foreground max-md:hidden">
            <span class="flex items-center gap-1.5 whitespace-nowrap max-[1100px]:hidden">
              <Kbd variant="hint">↑↓</Kbd>navigate
            </span>
            <span class="flex items-center gap-1.5 whitespace-nowrap max-[1100px]:hidden">
              <Kbd variant="hint">→</Kbd>open
            </span>
            <span class="whitespace-nowrap tabular-nums">{dirEntries.length} folders</span>
          </div>
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
        {#if !runtime.isMobileViewport}
          <Button variant="ghost" class="shrink-0 text-[0.8125rem]" onclick={onClose}>Cancel</Button>
        {/if}
        <Button
          class="shrink-0 px-3.5 text-[0.8125rem] max-md:h-11 max-md:flex-1"
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
{/if}

<style>
  /* svelte-tiny-virtual-list renders its scroller outside this component, and
     sets `overflow: auto` inline — which the row width rounds into a spurious
     horizontal bar, so the axis is closed off here. */
  .virtual-scroll :global(.virtual-list-wrapper) {
    overflow-x: hidden !important;
    overscroll-behavior-y: contain;
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

  /* The places rail turns into a swipeable strip on mobile; a bar under it just
     steals height from the row. */
  @media (max-width: 767px) {
    .places-rail::-webkit-scrollbar {
      width: 0;
      height: 0;
    }
  }

</style>
