<script lang="ts">
  import { Check as CheckIcon, ChevronDown as CaretDownIcon, Crown as CrownIcon, Globe as GlobeIcon, Link as LinkIcon, Lock as LockIcon, RefreshCw as RefreshIcon, Trash2 as TrashIcon, Users as UsersIcon, X as XIcon } from "@lucide/svelte";
  import type { ShareNamedSubject, ShareRole } from "@solus/contracts/sharing";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import BottomSheet from "../ui/bottom-sheet/bottom-sheet.svelte";
  import { runtime, sharesStore, uplinkStore } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { linkPresentation, ownerName, shareCandidates, shareRows, withRole, withoutSubject } from "./lib/share-rows";

  /**
   * One share dialog for sessions and works (docs/plans/multiplayer-sharing.md §4.1):
   * who has access, add people from the organization's directory, and the link.
   * A modal where there is a keyboard; a sheet raised from the bottom on a phone.
   *
   * The card sets the chrome rung once; every secondary line is `em`-relative to
   * it, so the whole dialog steps with the display like the settings rows do.
   */
  const target = $derived(sharesStore.dialog);
  const list = $derived(target ? sharesStore.listFor(target.serverId, target.resource) : undefined);
  const directory = $derived(target ? (sharesStore.directories.get(target.serverId) ?? null) : null);
  const identity = $derived(target ? sharesStore.identities.get(target.serverId) : undefined);
  const canShare = $derived(list?.callerRole === "editor" || list?.callerRole === "owner");
  const isOwner = $derived(list?.callerRole === "owner");
  // A host shared with a team gives every member full access (decision 2026-09-15):
  // there is nobody to add one by one, and "restricted" means the team.
  const teamHost = $derived(!!identity?.organizationId);
  const teamName = $derived(directory?.name ?? "your team");
  const rows = $derived(list ? shareRows(list, directory) : []);
  const linkContext = $derived(target ? sharesStore.linkContext(target.serverId) : null);
  const useSheet = $derived(runtime.isTouchDevice && !runtime.hasKeyboardPointer);

  let query = $state("");
  /** The modal card: menus portal into it so they paint above its own scrim. */
  let dialogEl = $state<HTMLElement | null>(null);
  const menuPortal = $derived(dialogEl ? { to: dialogEl } : undefined);
  const candidates = $derived(list ? shareCandidates(list, directory, query) : []);
  let copied = $state(false);

  $effect(() => {
    // A new target starts clean.
    void target;
    query = "";
    copied = false;
  });

  function close(): void {
    sharesStore.close();
    requestInputFocus();
  }

  async function setRole(subject: ShareNamedSubject, role: ShareRole): Promise<void> {
    if (!target || !list) return;
    await sharesStore.setGrants(target.serverId, withRole(list, subject, role));
  }

  async function remove(subject: ShareNamedSubject): Promise<void> {
    if (!target || !list) return;
    await sharesStore.setGrants(target.serverId, withoutSubject(list, subject));
  }

  async function add(subject: ShareNamedSubject): Promise<void> {
    query = "";
    await setRole(subject, "viewer");
  }

  async function setLinkRole(role: ShareRole | null, regenerate = false): Promise<void> {
    if (!target) return;
    await sharesStore.setLink(target.serverId, target.resource, role, regenerate);
    copied = false;
  }

  /** The link as the host now holds it: always at hand for whoever may share. */
  const link = $derived(list && linkContext ? linkPresentation(list.link, linkContext, canShare) : null);
  const copyText = $derived(link?.kind === "url" ? link.url : link?.kind === "secret" ? link.secret : null);
  /** Copy is one click on every open. With no link yet it makes one, so the dialog
   *  never sends the person to a menu first. */
  const canCopy = $derived(canShare && !sharesStore.busy && link?.kind !== "checking" && link?.kind !== "unavailable");

  async function copyLink(): Promise<void> {
    if (!target || !canCopy) return;
    let text = copyText;
    let created = false;
    if (!text) {
      const made = await sharesStore.setLink(target.serverId, target.resource, "viewer");
      if (!made) return;
      created = true;
      const fresh = linkContext ? linkPresentation({ role: "viewer", secret: made.secret }, linkContext, true) : null;
      text = fresh?.kind === "url" ? fresh.url : fresh?.kind === "secret" ? fresh.secret : null;
      if (!text) return;
    }
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      toasts.success(created ? "Link copied · anyone with it can view" : "Link copied");
    } catch {
      toasts.error("Couldn't copy the link");
    }
  }

  async function transfer(toUserId: string): Promise<void> {
    if (!target) return;
    await sharesStore.transfer(target.serverId, target.resource, toUserId);
  }

  const consentSentence = $derived(
    target?.resource.kind === "session" && list?.link?.role === "editor"
      ? "Turns started by guests run under your provider login on this host."
      : null,
  );
  const roleLabel = (role: ShareRole) => (role === "editor" ? "Editor" : "Viewer");
</script>

<!-- The row menus and the link menu share one trigger shape, so the list reads as one list. -->
{#snippet roleMenu(role: ShareRole, onRole: (role: ShareRole) => void, onRemove: () => void, onMakeOwner: (() => void) | null)}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="ghost" size="sm" class="gap-1 px-2 text-workspace-chrome font-normal text-muted-foreground hover:text-foreground pointer-coarse:h-10" disabled={!canShare || sharesStore.busy}>
          {roleLabel(role)}
          <CaretDownIcon />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" class="w-auto min-w-40" portalProps={menuPortal}>
      {#each ["viewer", "editor"] as const as option (option)}
        <DropdownMenu.Item onSelect={() => onRole(option)}>
          <span class="flex-1">{roleLabel(option)}</span>
          {#if option === role}<CheckIcon />{/if}
        </DropdownMenu.Item>
      {/each}
      {#if onMakeOwner}
        <DropdownMenu.Separator />
        <DropdownMenu.Item onSelect={onMakeOwner}>
          <CrownIcon /><span class="flex-1">Make owner</span>
        </DropdownMenu.Item>
      {/if}
      <DropdownMenu.Separator />
      <DropdownMenu.Item variant="destructive" onSelect={onRemove}>
        <TrashIcon /><span class="flex-1">Remove</span>
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/snippet}

{#snippet heading(label: string)}
  <h3 class="text-[0.875em] font-medium uppercase tracking-[0.04em] text-muted-foreground">{label}</h3>
{/snippet}

{#snippet body()}
  {#if !list}
    <p class="py-6 text-center text-muted-foreground" role="status">Loading who has access…</p>
  {:else}
    <section class="flex flex-col gap-1.5" aria-label="Who has access">
      {@render heading("Who has access")}
      <ul class="flex flex-col divide-y divide-border">
        <li class="flex min-h-9 items-center gap-3 py-1.5 pointer-coarse:min-h-11" data-testid="share-owner-row">
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-foreground">{ownerName(list.ownerUserId, directory, identity?.userId ?? null)}</span>
            {#if list.callerRole !== "owner"}<span class="truncate text-[0.875em] text-muted-foreground">Shared with you</span>{/if}
          </div>
          <span class="px-2 text-muted-foreground">Owner</span>
        </li>
        {#if teamHost}
          <li class="flex min-h-9 items-center gap-3 py-1.5 pointer-coarse:min-h-11" data-testid="share-team-row">
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="truncate text-foreground">Everyone in {teamName}</span>
              <span class="truncate text-[0.875em] text-muted-foreground">Members of the team see and edit everything on this host</span>
            </div>
            <span class="px-2 text-muted-foreground">Editor</span>
          </li>
        {/if}
        {#each rows as row (row.key)}
          <li class="flex min-h-9 items-center gap-3 py-1.5 pointer-coarse:min-h-11" data-testid="share-row">
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="truncate text-foreground">{row.name}</span>
              {#if row.detail}<span class="truncate text-[0.875em] text-muted-foreground">{row.detail}</span>{/if}
            </div>
            {#if canShare}
              {@render roleMenu(
                row.role,
                (role) => void setRole(row.subject, role),
                () => void remove(row.subject),
                isOwner && row.subject.kind === "user" ? () => row.subject.kind === "user" && void transfer(row.subject.id) : null,
              )}
            {:else}
              <span class="px-2 text-muted-foreground">{roleLabel(row.role)}</span>
            {/if}
          </li>
        {/each}
      </ul>
    </section>

    {#if canShare && !teamHost}
      <section class="flex flex-col gap-1.5" aria-label="Add people">
        {@render heading("Add people")}
        {#if directory}
          <Input bind:value={query} class="h-7 pointer-coarse:h-10" placeholder="Search people and teams" aria-label="Search people and teams" />
          {#if candidates.length > 0}
            <ul class="max-h-48 overflow-y-auto rounded-lg border border-border" data-testid="share-candidates">
              {#each candidates as candidate (candidate.key)}
                <li>
                  <button type="button" class="flex min-h-9 w-full items-center gap-3 px-2.5 py-1 text-left transition-colors hover:bg-muted pointer-coarse:min-h-11" onclick={() => void add(candidate.subject)} disabled={sharesStore.busy}>
                    <span class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate text-foreground">{candidate.name}</span>
                      <span class="truncate text-[0.875em] text-muted-foreground">{candidate.detail}</span>
                    </span>
                    <span class="text-[0.875em] text-muted-foreground">{candidate.group}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {:else if query}
            <p class="text-[0.875em] text-muted-foreground">Nobody in the organization matches.</p>
          {/if}
        {:else if !uplinkStore.accountAvailable || !identity?.organizationId}
          <p class="text-pretty text-[0.875em] text-muted-foreground">
            People can be added once this host is shared with an organization in Solus cloud. The link below works now.
          </p>
        {:else}
          <p class="text-[0.875em] text-muted-foreground" role="status">Loading the directory…</p>
        {/if}
      </section>
    {/if}

    <section class="flex flex-col gap-1.5" aria-label="General access">
      {@render heading("General access")}
      <div class="flex min-h-9 items-center gap-3 pointer-coarse:min-h-11">
        {#if list.link}<GlobeIcon size={14} class="shrink-0 text-muted-foreground" />{:else}<LockIcon size={14} class="shrink-0 text-muted-foreground" />{/if}
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-foreground">{list.link ? "Anyone with the link" : "Restricted"}</span>
          <span class="truncate text-[0.875em] text-muted-foreground">
            {list.link ? `Anyone on the internet with the link can ${list.link.role === "editor" ? "edit" : "view"}` : teamHost ? `Only ${teamName} can open it` : "Only people added above can open it"}
          </span>
        </span>
        {#if canShare}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Button {...props} variant="ghost" size="sm" class="gap-1 px-2 text-workspace-chrome font-normal text-muted-foreground hover:text-foreground pointer-coarse:h-10" data-testid="share-link-menu" disabled={sharesStore.busy}>
                  {list.link ? roleLabel(list.link.role) : "Off"}
                  <CaretDownIcon />
                </Button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end" class="w-auto min-w-44" portalProps={menuPortal}>
              <DropdownMenu.Item onSelect={() => void setLinkRole(null)}>
                <span class="flex-1">Off</span>{#if !list.link}<CheckIcon />{/if}
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void setLinkRole("viewer")}>
                <span class="flex-1">Viewer</span>{#if list.link?.role === "viewer"}<CheckIcon />{/if}
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void setLinkRole("editor")}>
                <span class="flex-1">Editor</span>{#if list.link?.role === "editor"}<CheckIcon />{/if}
              </DropdownMenu.Item>
              {#if list.link}
                <DropdownMenu.Separator />
                <DropdownMenu.Item onSelect={() => void setLinkRole(list.link?.role ?? "viewer", true)}>
                  <RefreshIcon /><span class="flex-1">Regenerate link</span>
                </DropdownMenu.Item>
              {/if}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        {/if}
      </div>
      {#if consentSentence}
        <p class="text-pretty text-[0.875em] text-muted-foreground" data-testid="share-consent">{consentSentence}</p>
      {/if}
      {#if link?.kind === "secret"}
        <p class="text-pretty text-[0.875em] text-muted-foreground">This host is not linked to Solus cloud, so Copy link copies the bare secret. Link the host under Connections to get a link.</p>
      {:else if link?.kind === "unavailable"}
        <p class="text-pretty text-[0.875em] text-muted-foreground">This link was made before the host kept links. Regenerate it to get one you can copy; the old one stops working.</p>
      {/if}
    </section>
  {/if}
{/snippet}

<!-- The footer is the dialog's two verbs: the link, one click away on every open,
     and the way out. The URL itself never needs to be read, so it is not shown. -->
{#snippet footer()}
  {#if canShare}
    <Button size="sm" variant="outline" class="gap-1.5 text-workspace-chrome pointer-coarse:h-10" onclick={copyLink} disabled={!canCopy} data-testid="share-copy-link" data-link={copyText ?? undefined}>
      {#if copied}<CheckIcon />{:else}<LinkIcon />{/if}
      {copied ? "Copied" : "Copy link"}
    </Button>
  {:else}
    <span></span>
  {/if}
  <Button size="sm" class="text-workspace-chrome pointer-coarse:h-10" onclick={close} data-testid="share-done">Done</Button>
{/snippet}

{#if target}
  {#if useSheet}
    <BottomSheet label={`Share ${target.title}`} onClose={close}>
      {#snippet header()}
        <span class="flex min-w-0 items-center gap-2 font-medium text-foreground">
          <UsersIcon size={14} class="shrink-0 text-(--solus-accent)" />
          <span class="truncate">Share “{target.title}”</span>
        </span>
      {/snippet}
      <div class="flex flex-col gap-4 pb-2">{@render body()}</div>
      {#snippet footer()}
        <div class="flex items-center justify-between gap-3">{@render footer()}</div>
      {/snippet}
    </BottomSheet>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      data-solus-ui
      class="fixed inset-0 z-[10008] flex items-start justify-center bg-[color-mix(in_srgb,var(--solus-modal-scrim)_55%,transparent)] px-4 pt-[14vh] pointer-events-auto motion-safe:animate-[backdrop-fade_140ms_ease-out]"
      role="presentation"
      onclick={(event) => { if (event.target === event.currentTarget) close(); }}
      onkeydown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}
    >
      <div
        class="share-dialog-enter flex max-h-[min(38rem,80svh)] w-[clamp(20rem,40vw,28rem)] max-w-[calc(100vw-3rem)] origin-top flex-col overflow-hidden rounded-2xl border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) text-workspace-chrome shadow-[shadow:var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.24),0_4.375rem_8.125rem_-3.125rem_rgba(0,0,0,0.34)] [.dark_&]:shadow-[shadow:var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.06),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.45),0_4.375rem_8.125rem_-3.125rem_rgba(0,0,0,0.55)]"
        role="dialog"
        aria-label={`Share ${target.title}`}
        aria-modal="true"
        data-testid="share-dialog"
        bind:this={dialogEl}
      >
        <div class="relative flex h-[2.875rem] shrink-0 items-center gap-2 px-[1.125rem] after:absolute after:bottom-0 after:left-[1.125rem] after:right-[1.125rem] after:h-[0.0625rem] after:bg-(--solus-popover-border) after:opacity-[0.35] after:content-['']">
          <UsersIcon size={14} class="shrink-0 text-(--solus-accent)" />
          <span class="min-w-0 flex-1 truncate font-medium text-foreground">Share “{target.title}”</span>
          <button
            type="button"
            class="relative ml-auto inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border-none bg-transparent text-muted-foreground transition-[background-color,color,scale] duration-100 hover:bg-muted hover:text-foreground active:scale-[0.96] after:absolute after:-inset-1.5 after:content-['']"
            onclick={close}
            aria-label="Close"
            title="Close"
          >
            <XIcon size={14} />
          </button>
        </div>
        <div class="flex flex-col gap-4 overflow-y-auto px-[1.125rem] py-3.5">{@render body()}</div>
        <div class="relative flex h-[3.25rem] shrink-0 items-center justify-between gap-3 px-[1.125rem] before:absolute before:left-[1.125rem] before:right-[1.125rem] before:top-0 before:h-[0.0625rem] before:bg-(--solus-popover-border) before:opacity-[0.35] before:content-['']">
          {@render footer()}
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  /* Keyframes cannot be expressed as Tailwind utilities. `backwards`, not
     `both`: a retained end transform keeps the panel on its own compositing
     layer and blurs its text (see index.css msg-in-up note). */
  .share-dialog-enter {
    animation: share-dialog-enter 180ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  }

  @media (prefers-reduced-motion: reduce) {
    .share-dialog-enter {
      animation: none;
    }
  }

  @keyframes share-dialog-enter {
    from {
      opacity: 0;
      transform: translate3d(0, 0.25rem, 0) scale(0.985);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
    }
  }
</style>
