<script lang="ts">
  import { Building2 as OrganizationIcon, Check as CheckIcon, ChevronDown as CaretDownIcon, Globe as GlobeIcon, Link as LinkIcon, LoaderCircle as CircleNotchIcon, Lock as LockIcon, Users as UsersIcon, X as XIcon } from "@lucide/svelte";
  import type { ShareRole } from "@solus/contracts/sharing";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import BottomSheet from "../ui/bottom-sheet/bottom-sheet.svelte";
  import { runtime, sharesStore } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { linkPresentation, ownerLabel, personCandidates, personRows, scopeKey, scopeOf, scopeOptions, sharedWithMembers, type PersonRow, type ScopeOption } from "./lib/share-rows";
  import { publishProblemMessage } from "./lib/publish-copy";
  import { userKey } from "@solus/contracts/user";
  import UserAvatar from "../users/UserAvatar.svelte";

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
  const target = $derived(sharesStore.dialog);
  /** Set while the resource is still on a machine: Share uploads it first (organization-scope §7). */
  const publication = $derived(target?.publication ?? null);
  const publishProblem = $derived(
    publication && target ? publishProblemMessage(publication.status, target.resource.kind, publication.organizationName) : null,
  );
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

  const people = $derived(list ? personRows(list, directory, identity?.user ?? null) : []);
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
  const kindWord = $derived(target?.resource.kind ?? "session");

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

  const roleLabel = (role: ShareRole | "owner") => (role === "owner" ? "Owner" : role === "editor" ? "Can edit" : role === "commenter" ? "Can comment" : "Can view");
  // Only a work has comments and review decisions, so only a work offers a commenter.
  const roleChoices = $derived<readonly ShareRole[]>(target?.resource.kind === "work" ? ["viewer", "commenter", "editor"] : ["viewer", "editor"]);

  const linkContext = $derived(target ? sharesStore.linkContext(target.serverId) : null);
  /** The link as the host now holds it: always at hand for whoever may share. */
  const link = $derived(list && linkContext ? linkPresentation(list.link, linkContext, canShare, list.resource) : null);
  /** Shared with members only: the app's address, which each opens with their own sign-in. */
  const memberLink = $derived(target && list && sharedWithMembers(list) ? sharesStore.memberLinkUrl(target.serverId, target.resource) : null);
  const copyText = $derived(memberLink ?? (link?.kind === "url" ? link.url : link?.kind === "secret" ? link.secret : null));
  /** Copy is one click on every open. With no link yet it widens the scope to the
   *  link first, so the dialog never sends the person to a choice before the verb. */
  const canCopy = $derived(canShare && !sharesStore.busy && link?.kind !== "checking" && link?.kind !== "unavailable");

  async function copyLink(): Promise<void> {
    if (!target || !list || !canCopy) return;
    let text = copyText;
    let widened = false;
    if (!text) {
      await sharesStore.setScope(target.serverId, list, { kind: "link", role: "viewer" });
      const now = sharesStore.listFor(target.serverId, target.resource);
      const fresh = now && linkContext ? linkPresentation(now.link, linkContext, true, now.resource) : null;
      text = fresh?.kind === "url" ? fresh.url : fresh?.kind === "secret" ? fresh.secret : null;
      if (!text) return;
      widened = true;
    }
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      toasts.success(widened ? "Link copied · anyone with it can view" : memberLink ? "Link copied · only people with access can open it" : "Link copied");
    } catch {
      toasts.error("Couldn't copy the link");
    }
  }
</script>

{#snippet scopeIcon(option: ScopeOption)}
  {#if option.scope.kind === "private"}
    <LockIcon size={16} class="size-4 shrink-0" />
  {:else if option.scope.kind === "team"}
    <UsersIcon size={16} class="size-4 shrink-0" />
  {:else if option.scope.kind === "organization"}
    <OrganizationIcon size={16} class="size-4 shrink-0" />
  {:else}
    <GlobeIcon size={16} class="size-4 shrink-0" />
  {/if}
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
      {#each roleChoices as role (role)}
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
  {#if publication && target}
    <!-- Share is the opt-in: the resource is already on its way to the
         window's organization, and the list below takes its place on receipt. -->
    <section class="flex flex-col gap-2" aria-label="Uploading" data-testid="share-publish" data-state={publication.status.kind}>
      {#if publication.status.kind === "pending"}
        <p class="flex items-center gap-2 py-4 text-muted-foreground" role="status">
          <CircleNotchIcon size={14} class="shrink-0 motion-safe:animate-spin" />
          Uploading to {publication.organizationName} to get a link…
        </p>
      {:else if publishProblem}
        <p class="text-pretty text-(--solus-status-error)" role="alert">{publishProblem}</p>
      {/if}
      <p class="text-pretty text-[0.875em] text-muted-foreground">
        Sharing keeps this {kindWord} in {publication.organizationName}. The work keeps running on the computer that holds it.
      </p>
    </section>
  {:else if !list}
    <p class="py-6 text-center text-muted-foreground" role="status">Loading who can open it…</p>
  {:else}
    {#if canShare && canInvite}
      <div class="relative">
        <Input
          bind:value={query}
          placeholder="Add people"
          aria-label="Add people"
          data-testid="share-add-people"
          class="h-10 rounded-lg px-3 text-workspace-chrome pointer-coarse:h-11"
          disabled={sharesStore.busy}
        />
        {#if query.trim() && candidates.length}
          <ul class="absolute inset-x-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-lg border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) p-1 shadow-[shadow:var(--solus-popover-shadow)]" role="listbox" aria-label="People to add">
            {#each candidates as candidate (userKey(candidate.id))}
              {@const candidateKey = userKey(candidate.id)}
              <li>
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  class="flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-left hover:bg-muted pointer-coarse:min-h-11"
                  data-testid="share-candidate"
                  data-user-id={candidateKey}
                  onclick={() => void invite(candidateKey)}
                >
                  <UserAvatar user={candidate} size={24} />
                  <span class="flex min-w-0 flex-1 flex-col leading-tight">
                    <span class="truncate text-foreground">{candidate.displayName}</span>
                    {#if candidate.email}<span class="truncate text-[0.875em] text-muted-foreground">{candidate.email}</span>{/if}
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {:else if query.trim()}
          <p class="px-1 pt-1.5 text-[0.875em] text-muted-foreground">Nobody in the organization matches.</p>
        {/if}
      </div>
    {/if}

    <!-- Link access: one choice, widest last. Each choice holds the ones
         before it — the organization has every team, the link has everyone — so
         widening never takes the resource from a group that had it. Each
         choice explains itself in the menu, not on the dialog. -->
    <section class="flex flex-col gap-2.5" aria-label="Link access">
      <h3 class="font-medium text-foreground">Link access</h3>
      {#if selected}
        <div class="flex min-h-10 items-center gap-3 pointer-coarse:min-h-12">
          <span class="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">{@render scopeIcon(selected)}</span>
          <span class="flex min-w-0 flex-1 items-center">
            {#if canShare}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <button {...props} type="button" class="-mx-1.5 inline-flex h-8 max-w-full min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-left text-foreground hover:bg-muted data-[state=open]:bg-transparent disabled:cursor-default pointer-coarse:h-10" title={selected.detail} data-testid="share-scope" data-scope={selected.key} disabled={sharesStore.busy}>
                      <span class="truncate">{selected.name}</span>
                      <CaretDownIcon size={16} class="shrink-0 text-muted-foreground" />
                    </button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="start" class="w-auto min-w-72 p-1.5" portalProps={menuPortal}>
                  {#each options as option (option.key)}
                    <DropdownMenu.Item onSelect={() => void chooseScope(option)} class="h-auto gap-3 py-2" data-testid="share-scope-option" data-scope={option.key}>
                      {@render scopeIcon(option)}
                      <span class="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
                        <span class="truncate">{option.name}</span>
                        <span class="truncate text-[0.875em] text-muted-foreground">{option.detail}</span>
                      </span>
                      {#if option.key === selected.key}<CheckIcon />{/if}
                    </DropdownMenu.Item>
                  {/each}
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            {:else}
              <span class="truncate text-foreground" title={selected.detail}>{selected.name}</span>
            {/if}
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
      {#if link?.kind === "secret"}
        <p class="text-pretty text-[0.875em] text-muted-foreground">Copy link copies the bare secret. Link this host under Connections to get a link.</p>
      {:else if link?.kind === "unavailable"}
        <p class="text-pretty text-[0.875em] text-muted-foreground">This old link cannot be copied. Choose another access, then the link again, to get a new one.</p>
      {/if}
    </section>

    <!-- People invited by name, the owner first. Each has a role of their own:
         a person named here keeps it whatever the link access above says. -->
    <section class="flex flex-col gap-2.5" aria-label="Who has access">
      <h3 class="font-medium text-foreground">Who has access</h3>
      <ul class="flex flex-col gap-1" data-testid="share-people">
        {#each people as person (person.userId)}
          <li class="flex min-h-10 items-center gap-3 pointer-coarse:min-h-12" data-testid="share-person" data-user-id={person.userId} data-role={person.role}>
            <UserAvatar user={person.user} size={32} />
            <span class="min-w-0 flex-1 truncate text-foreground" title={person.detail || undefined}>{person.user.displayName}{person.isSelf ? " (you)" : ""}</span>
            {#if person.role === "owner" || !canShare}
              <span class="mr-2 shrink-0 text-muted-foreground">{roleLabel(person.role)}</span>
            {:else}
              {@render roleMenu(person.role, (role) => void setRole(person, role), () => void remove(person), "share-person-role")}
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/snippet}

<!-- The footer is the dialog's two verbs: the link, one click away on every open,
     and the way out. The URL itself never needs to be read, so it is not shown. -->
{#snippet dialogFooter()}
  {#if publication}
    {#if publication.status.kind === "failed" || publication.status.kind === "offline" || publication.status.kind === "waiting"}
      <Button variant="outline" class="h-10 rounded-full px-4 text-workspace-chrome" onclick={() => void sharesStore.publish()} data-testid="share-publish-retry">Retry</Button>
    {:else}
      <span></span>
    {/if}
  {:else if canShare}
    <Button variant="outline" class="h-10 gap-2 rounded-full px-4 text-workspace-chrome" onclick={copyLink} disabled={!canCopy} data-testid="share-copy-link" data-link={copyText ?? undefined}>
      {#if copied}<CheckIcon />{:else}<LinkIcon />{/if}
      {copied ? "Copied" : "Copy link"}
    </Button>
  {:else}
    <span></span>
  {/if}
  <Button class="h-10 rounded-full px-5 text-workspace-chrome" onclick={close} data-testid="share-done">Done</Button>
{/snippet}

{#if target}
  {#if useSheet}
    <BottomSheet label={`Share ${target.title}`} onClose={close}>
      {#snippet header()}
        <span class="min-w-0 truncate font-semibold text-foreground">Share {target.title}</span>
      {/snippet}
      <div class="flex flex-col gap-6 pb-2">{@render dialogBody()}</div>
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
        class="share-dialog-enter flex max-h-[min(38rem,80svh)] w-[clamp(22rem,40vw,30rem)] max-w-[calc(100vw-3rem)] origin-top flex-col overflow-hidden rounded-2xl border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) text-workspace-chrome shadow-[shadow:var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.24),0_4.375rem_8.125rem_-3.125rem_rgba(0,0,0,0.34)] [.dark_&]:shadow-[shadow:var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.06),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.45),0_4.375rem_8.125rem_-3.125rem_rgba(0,0,0,0.55)]"
        role="dialog"
        aria-label={`Share ${target.title}`}
        aria-modal="true"
        data-testid="share-dialog"
        data-kind={target.resource.kind}
        bind:this={dialogEl}
      >
        <div class="flex shrink-0 items-center gap-2 px-6 pt-6 pb-5">
          <h2 class="min-w-0 flex-1 truncate text-[1.25em] font-semibold text-foreground" title={`Share this ${kindWord}`}>Share {target.title}</h2>
          <button
            type="button"
            class="relative ml-auto inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border-none bg-transparent text-muted-foreground transition-[background-color,color,scale] duration-100 hover:bg-muted hover:text-foreground active:scale-[0.96] after:absolute after:-inset-1.5 after:content-['']"
            onclick={close}
            aria-label="Close"
            title="Close"
          >
            <XIcon size={18} />
          </button>
        </div>
        <div class="flex flex-col gap-6 overflow-y-auto px-6 pb-2">{@render dialogBody()}</div>
        <div class="flex shrink-0 items-center justify-between gap-3 px-6 pt-6 pb-6">
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
