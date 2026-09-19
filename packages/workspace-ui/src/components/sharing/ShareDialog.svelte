<script lang="ts">
  import { Building2 as OrganizationIcon, Check as CheckIcon, ChevronDown as CaretDownIcon, CloudUpload as CloudUploadIcon, Globe as GlobeIcon, Link as LinkIcon, Lock as LockIcon, Users as UsersIcon, X as XIcon } from "@lucide/svelte";
  import type { ShareRole } from "@solus/contracts/sharing";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import BottomSheet from "../ui/bottom-sheet/bottom-sheet.svelte";
  import { getWorkspaceContext, runtime, serversStore, sharesStore, uplinkStore } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { linkPresentation, ownerLabel, personCandidates, personRows, scopeKey, scopeOf, scopeOptions, type PersonRow, type ScopeOption } from "./lib/share-rows";

  /**
   * One share dialog for sessions, works, and tasks (docs/plans/multiplayer-sharing.md
   * §4.1). Two sections, as a document's: the people invited by name, each with a
   * role of their own, and general access — one choice of who else can open it,
   * with one role for that choice. A modal where there is a keyboard; a sheet
   * raised from the bottom on a phone.
   *
   * The card sets the chrome rung once; every secondary line is `em`-relative to
   * it, so the whole dialog steps with the display like the settings rows do.
   */
  const session = getWorkspaceContext();
  const target = $derived(sharesStore.dialog);
  const list = $derived(target ? sharesStore.listFor(target.serverId, target.resource) : undefined);
  const directory = $derived(target ? (sharesStore.directories.get(target.serverId) ?? null) : null);
  const identity = $derived(target ? sharesStore.identities.get(target.serverId) : undefined);
  const canShare = $derived(list?.callerRole === "editor" || list?.callerRole === "owner");
  const useSheet = $derived(runtime.isTouchDevice && !runtime.hasKeyboardPointer);

  let copied = $state(false);
  let query = $state("");
  /** The modal card: the menus portal into it so they paint above its own scrim. */
  let dialogEl = $state<HTMLElement | null>(null);
  const menuPortal = $derived(dialogEl ? { to: dialogEl } : undefined);

  $effect(() => {
    // A new target starts clean.
    void target;
    copied = false;
    query = "";
  });

  const people = $derived(list ? personRows(list, directory, identity?.userId ?? null) : []);
  const candidates = $derived(list && canShare ? personCandidates(list, directory, query) : []);
  const canInvite = $derived(!!directory && directory.members.length > 1);

  const options = $derived(list ? scopeOptions(list, directory, identity?.organizationId ?? null, ownerLabel(list, directory)) : []);
  const selectedKey = $derived(list ? scopeKey(scopeOf(list)) : "private");
  const selected = $derived(options.find((option) => option.key === selectedKey) ?? options[0]);
  const consentSentence = $derived(
    target && target.resource.kind !== "work" && list?.link?.role === "editor"
      ? "Turns started by guests run under the login of whoever made the link."
      : null,
  );
  const kindWord = $derived(target?.resource.kind === "task" ? "task, its sessions, and its documents" : target?.resource.kind ?? "session");

  function close(): void {
    sharesStore.close();
    requestInputFocus();
  }

  /** The general-access choice, or a role on it: either way the option becomes the scope, with that role. */
  async function chooseScope(option: ScopeOption, role?: ShareRole): Promise<void> {
    if (!target || !list || !canShare) return;
    copied = false;
    const scope = role && option.scope.kind !== "private" ? { ...option.scope, role } : option.scope;
    await sharesStore.setScope(target.serverId, list, scope);
  }

  async function invite(userId: string): Promise<void> {
    if (!target || !list || !canShare) return;
    query = "";
    await sharesStore.setPersonRole(target.serverId, list, userId, "editor");
  }

  async function setRole(person: PersonRow, role: ShareRole): Promise<void> {
    if (!target || !list || !canShare || person.role === role) return;
    await sharesStore.setPersonRole(target.serverId, list, person.userId, role);
  }

  async function remove(person: PersonRow): Promise<void> {
    if (!target || !list || !canShare) return;
    await sharesStore.removePerson(target.serverId, list, person.userId);
  }

  const roleLabel = (role: ShareRole | "owner") => (role === "owner" ? "Owner" : role === "editor" ? "Can edit" : "Can view");

  const linkContext = $derived(target ? sharesStore.linkContext(target.serverId) : null);
  /** The link as the host now holds it: always at hand for whoever may share. */
  const link = $derived(list && linkContext ? linkPresentation(list.link, linkContext, canShare) : null);
  const copyText = $derived(link?.kind === "url" ? link.url : link?.kind === "secret" ? link.secret : null);
  /** Copy is one click on every open. With no link yet it widens the scope to the
   *  link first, so the dialog never sends the person to a choice before the verb. */
  const canCopy = $derived(canShare && !sharesStore.busy && link?.kind !== "checking" && link?.kind !== "unavailable");

  // A work on a machine, with the organization's workspace service connected:
  // the durable share is the cloud row, so the dialog offers the move and then
  // reopens on it (docs/plans/cloud-service-model.md R6). Not for sessions and
  // tasks, which are not moved this way.
  const cloudHost = $derived(serversStore.connectedCloudServer);
  const offersMoveToCloud = $derived(
    !!target && target.resource.kind === "work" && !!cloudHost && !serversStore.isCloudHost(target.serverId) && canShare,
  );
  let movingToCloud = $state(false);
  async function moveToCloudAndShare(): Promise<void> {
    if (!target || !cloudHost || movingToCloud) return;
    const { resource, title: workTitle } = target;
    movingToCloud = true;
    try {
      await session.worksStore.moveToCloud(resource.id, cloudHost.id);
      sharesStore.open({ serverId: cloudHost.id, resource, title: workTitle });
      toasts.success(`Moved to Solus Cloud · ${cloudHost.label}`);
    } catch (error) {
      toasts.error("Couldn't move this work to Solus Cloud", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      movingToCloud = false;
    }
  }

  async function copyLink(): Promise<void> {
    if (!target || !list || !canCopy) return;
    let text = copyText;
    let widened = false;
    if (!text) {
      await sharesStore.setScope(target.serverId, list, { kind: "link", role: "viewer" });
      const now = sharesStore.listFor(target.serverId, target.resource);
      const fresh = now && linkContext ? linkPresentation(now.link, linkContext, true) : null;
      text = fresh?.kind === "url" ? fresh.url : fresh?.kind === "secret" ? fresh.secret : null;
      if (!text) return;
      widened = true;
    }
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      toasts.success(widened ? "Link copied · anyone with it can view" : "Link copied");
    } catch {
      toasts.error("Couldn't copy the link");
    }
  }
</script>

{#snippet scopeIcon(option: ScopeOption)}
  {#if option.scope.kind === "private"}
    <LockIcon size={14} class="shrink-0" />
  {:else if option.scope.kind === "team"}
    <UsersIcon size={14} class="shrink-0" />
  {:else if option.scope.kind === "organization"}
    <OrganizationIcon size={14} class="shrink-0" />
  {:else}
    <GlobeIcon size={14} class="shrink-0" />
  {/if}
{/snippet}

{#snippet face(name: string, avatarUrl: string | null)}
  <span class="relative inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[0.75em] font-medium text-muted-foreground select-none" aria-hidden="true">
    {name.trim().slice(0, 1).toUpperCase()}
    {#if avatarUrl}<img src={avatarUrl} alt="" class="absolute inset-0 size-full object-cover" />{/if}
  </span>
{/snippet}

{#snippet roleMenu(current: ShareRole, onSelect: (role: ShareRole) => void, onRemove: (() => void) | null, testId: string)}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="ghost" size="sm" class="shrink-0 gap-1 px-2 text-workspace-chrome font-normal text-muted-foreground hover:text-foreground pointer-coarse:h-10" data-testid={testId} disabled={sharesStore.busy}>
          {roleLabel(current)}
          <CaretDownIcon />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" class="w-auto min-w-36" portalProps={menuPortal}>
      {#each ["viewer", "editor"] as const as role (role)}
        <DropdownMenu.Item onSelect={() => onSelect(role)}>
          <span class="flex-1">{roleLabel(role)}</span>
          {#if role === current}<CheckIcon />{/if}
        </DropdownMenu.Item>
      {/each}
      {#if onRemove}
        <DropdownMenu.Separator />
        <DropdownMenu.Item onSelect={onRemove}>Remove access</DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/snippet}

{#snippet dialogBody()}
  {#if !list}
    <p class="py-6 text-center text-muted-foreground" role="status">Loading who can open it…</p>
  {:else}
    <!-- People invited by name, the owner first. Each has a role of their own:
         a person named here keeps it whatever the general access below says. -->
    <section class="flex flex-col gap-1.5" aria-label="People with access">
      <h3 class="text-[0.875em] font-medium uppercase tracking-[0.04em] text-muted-foreground">People with access</h3>
      {#if canShare && canInvite}
        <div class="relative">
          <Input
            bind:value={query}
            placeholder="Add people by name or email"
            aria-label="Add people"
            data-testid="share-add-people"
            class="h-9 text-workspace-chrome pointer-coarse:h-10"
            disabled={sharesStore.busy}
          />
          {#if query.trim() && candidates.length}
            <ul class="absolute inset-x-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-lg border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) p-1 shadow-[shadow:var(--solus-popover-shadow)]" role="listbox" aria-label="People to add">
              {#each candidates as candidate (candidate.userId)}
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    class="flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-left hover:bg-muted pointer-coarse:min-h-11"
                    data-testid="share-candidate"
                    data-user-id={candidate.userId}
                    onclick={() => void invite(candidate.userId)}
                  >
                    {@render face(candidate.name, candidate.avatarUrl)}
                    <span class="flex min-w-0 flex-1 flex-col leading-tight">
                      <span class="truncate text-foreground">{candidate.name}</span>
                      {#if candidate.detail}<span class="truncate text-[0.875em] text-muted-foreground">{candidate.detail}</span>{/if}
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          {:else if query.trim()}
            <p class="px-1 pt-1.5 text-[0.875em] text-muted-foreground">Nobody in the organization matches. Anyone else can use the link.</p>
          {/if}
        </div>
      {/if}
      <ul class="flex flex-col gap-0.5" data-testid="share-people">
        {#each people as person (person.userId)}
          <li class="flex min-h-10 items-center gap-2.5 rounded-lg px-1.5 pointer-coarse:min-h-12" data-testid="share-person" data-user-id={person.userId} data-role={person.role}>
            {@render face(person.name, person.avatarUrl)}
            <span class="flex min-w-0 flex-1 flex-col leading-tight">
              <span class="truncate text-foreground">{person.name}{person.isSelf ? " (you)" : ""}</span>
              {#if person.detail}<span class="truncate text-[0.875em] text-muted-foreground">{person.detail}</span>{/if}
            </span>
            {#if person.role === "owner" || !canShare}
              <span class="mr-2 shrink-0 text-muted-foreground">{roleLabel(person.role)}</span>
            {:else}
              {@render roleMenu(person.role, (role) => void setRole(person, role), () => void remove(person), "share-person-role")}
            {/if}
          </li>
        {/each}
      </ul>
      {#if list.inheritedFrom?.length}
        <p class="text-pretty text-[0.875em] text-muted-foreground" data-testid="share-inherited">
          Also open to whoever can open {list.inheritedFrom.length === 1 ? `the task “${list.inheritedFrom[0]!.title}”` : `${list.inheritedFrom.length} tasks it belongs to`}.
        </p>
      {/if}
    </section>

    <!-- General access: one choice, widest last. Each choice holds the ones
         before it — the organization has every team, the link has everyone — so
         widening never takes the resource from a group that had it. -->
    <section class="flex flex-col gap-1.5" aria-label="General access">
      <h3 class="text-[0.875em] font-medium uppercase tracking-[0.04em] text-muted-foreground">General access</h3>
      {#if selected}
        <div class="flex min-h-10 items-center gap-2.5 rounded-lg px-1.5 pointer-coarse:min-h-12">
          <span class="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">{@render scopeIcon(selected)}</span>
          <span class="flex min-w-0 flex-1 flex-col leading-tight">
            {#if canShare}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <button {...props} type="button" class="-mx-1 inline-flex h-7 max-w-full cursor-pointer items-center gap-1 rounded-md px-1 text-left text-foreground hover:bg-muted disabled:cursor-default pointer-coarse:h-9" data-testid="share-scope" data-scope={selected.key} disabled={sharesStore.busy}>
                      <span class="truncate">{selected.name}</span>
                      <CaretDownIcon size={14} class="shrink-0 text-muted-foreground" />
                    </button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="start" class="w-auto min-w-56" portalProps={menuPortal}>
                  {#each options as option (option.key)}
                    <DropdownMenu.Item onSelect={() => void chooseScope(option)} data-testid="share-scope-option" data-scope={option.key}>
                      {@render scopeIcon(option)}
                      <span class="flex-1">{option.name}</span>
                      {#if option.key === selected.key}<CheckIcon />{/if}
                    </DropdownMenu.Item>
                  {/each}
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            {:else}
              <span class="truncate text-foreground">{selected.name}</span>
            {/if}
            <span class="truncate text-[0.875em] text-muted-foreground" data-testid="share-scope-detail">{selected.detail}</span>
          </span>
          {#if selected.role}
            {#if canShare}
              {@render roleMenu(selected.role, (role) => void chooseScope(selected, role), null, "share-scope-role")}
            {:else}
              <span class="mr-2 shrink-0 text-muted-foreground">{roleLabel(selected.role)}</span>
            {/if}
          {/if}
        </div>
      {/if}
      {#if consentSentence}
        <p class="text-pretty text-[0.875em] text-muted-foreground" data-testid="share-consent">{consentSentence}</p>
      {/if}
      {#if target?.resource.kind === "task"}
        <p class="text-pretty text-[0.875em] text-muted-foreground">Sharing this task shares its page, its sessions, and its documents.</p>
      {/if}
      {#if !uplinkStore.accountAvailable && !identity?.organizationId && options.length === 2}
        <p class="text-pretty text-[0.875em] text-muted-foreground">Teams appear here once this host is shared with an organization in Solus cloud. The link works now.</p>
      {/if}
      {#if link?.kind === "secret"}
        <p class="text-pretty text-[0.875em] text-muted-foreground">This host is not linked to Solus cloud, so Copy link copies the bare secret. Link the host under Connections to get a link.</p>
      {:else if link?.kind === "unavailable"}
        <p class="text-pretty text-[0.875em] text-muted-foreground">This link was made before the host kept links. Choose another access and come back to the link to get one you can copy; the old one stops working.</p>
      {/if}
    </section>
  {/if}
{/snippet}

<!-- The footer is the dialog's two verbs: the link, one click away on every open,
     and the way out. The URL itself never needs to be read, so it is not shown. -->
{#snippet dialogFooter()}
  {#if offersMoveToCloud}
    <Button size="sm" variant="outline" class="gap-1.5 text-workspace-chrome pointer-coarse:h-10" onclick={() => void moveToCloudAndShare()} disabled={movingToCloud || sharesStore.busy} data-testid="share-move-to-cloud">
      <CloudUploadIcon />
      {movingToCloud ? "Moving…" : "Move to Solus Cloud and share"}
    </Button>
  {:else if canShare}
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
      <div class="flex flex-col gap-4 pb-2">{@render dialogBody()}</div>
      {#snippet footer()}
        <div class="flex items-center justify-between gap-3">{@render dialogFooter()}</div>
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
        data-kind={target.resource.kind}
        bind:this={dialogEl}
      >
        <div class="relative flex h-[2.875rem] shrink-0 items-center gap-2 px-[1.125rem] after:absolute after:bottom-0 after:left-[1.125rem] after:right-[1.125rem] after:h-[0.0625rem] after:bg-(--solus-popover-border) after:opacity-[0.35] after:content-['']">
          <UsersIcon size={14} class="shrink-0 text-(--solus-accent)" />
          <span class="min-w-0 flex-1 truncate font-medium text-foreground" title={`Share this ${kindWord}`}>Share “{target.title}”</span>
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
        <div class="flex flex-col gap-4 overflow-y-auto px-[1.125rem] py-3.5">{@render dialogBody()}</div>
        <div class="relative flex h-[3.25rem] shrink-0 items-center justify-between gap-3 px-[1.125rem] before:absolute before:left-[1.125rem] before:right-[1.125rem] before:top-0 before:h-[0.0625rem] before:bg-(--solus-popover-border) before:opacity-[0.35] before:content-['']">
          {@render dialogFooter()}
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
