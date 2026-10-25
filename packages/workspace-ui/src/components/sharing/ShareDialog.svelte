<script lang="ts">
  import { Building2 as OrganizationIcon, Check as CheckIcon, ChevronDown as CaretDownIcon, Copy as CopyIcon, Globe as GlobeIcon, LoaderCircle as CircleNotchIcon, Lock as LockIcon, TriangleAlert as WarningIcon, Users as UsersIcon } from "@lucide/svelte";
  import { Switch } from "../ui/switch";
  import type { SessionActionLeaf } from "@solus/contracts/permissions";
  import type { ShareRole } from "@solus/contracts/sharing";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import BottomSheet from "../ui/bottom-sheet/bottom-sheet.svelte";
  import { accountStore, runtime, serversStore, sharesStore } from "../../contexts";
  import { uplinkStore } from "../../contexts/connections/uplink.store.svelte";
  import { logShareDialog } from "../../contexts/sharing/shares.store.svelte";
  import { isSolusApiId } from "@solus/contracts/uplink";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { LINK_LIFETIME_CHOICES, customActionRows, linkExpiryLabel, linkPresentation, ownerLabel, personCandidates, personRows, scopeKey, scopeOf, scopeOptions, linkToCopy, toggledActions, type PersonRow, type ScopeOption } from "./lib/share-rows";
  import { publishProblemMessage } from "./lib/publish-copy";
  import { userKey } from "@solus/contracts/user";
  import UserAvatar from "../users/UserAvatar.svelte";

  /**
   * One share dialog for sessions, works, and tasks (docs/plans/multiplayer-sharing.md
   * §4.1). A row to add people and copy the link, then one list of who has
   * access: general access first — one choice of who else can open it, with one
   * role for that choice — then the people invited by name, each with a role of
   * their own. A modal where there is a keyboard; a sheet raised from the bottom
   * on a phone.
   *
   * The card sets the chrome rung once; every secondary line is `em`-relative to
   * it, so the whole dialog steps with the display like the settings rows do.
   */
  const target = $derived(sharesStore.dialog);
  /** Set while a Local work uploads: Share uploads it first (cloud-sharing.md §3). */
  const publication = $derived(target?.publication ?? null);
  const publishProblem = $derived(
    publication && target ? publishProblemMessage(publication.status, target.resource.kind, publication.organizationName) : null,
  );
  const list = $derived(target ? sharesStore.listFor(target.serverId, target.resource) : undefined);
  const directory = $derived(target ? sharesStore.directory : null);
  /** Until the first answer, a person the list names cannot be told from a former member. */
  const peopleLoaded = $derived(target ? sharesStore.directoryLoaded : false);
  const identity = $derived(target ? sharesStore.identities.get(target.serverId) : undefined);
  const canShare = $derived(list?.callerRole === "editor" || list?.callerRole === "owner");
  const useSheet = $derived(runtime.isTouchDevice && !runtime.hasKeyboardPointer);

  let copied = $state(false);
  let query = $state("");
  /** The modal card: the menus portal into it so they paint above its own scrim. */
  let dialogEl = $state<HTMLElement | null>(null);
  const menuPortal = $derived(dialogEl ? { to: dialogEl } : undefined);

  $effect(() => {
    // Runs after the dialog's markup is in the DOM for this target.
    if (target) logShareDialog("share_dialog_shown", target);
  });

  $effect(() => {
    // A new target starts clean.
    void target;
    copied = false;
    query = "";
  });

  const people = $derived(list ? personRows(list, directory, identity?.user ?? null) : []);
  const candidates = $derived(list && canShare ? personCandidates(list, directory, query) : []);
  /** A member reaches a host with an account token, which needs the host registered (not linked); the Solus API is reached as itself. Assumed until the host answers. */
  const membersReachable = $derived(!target || isSolusApiId(target.serverId) || uplinkStore.statusFor(target.serverId)?.registration.registered !== false);
  const canInvite = $derived(!!directory && directory.members.length > 1 && membersReachable);
  /** The field is on screen while the organization's people load, so the row does not move when they arrive. */
  const peopleLoading = $derived(!peopleLoaded && !!serversStore.activeOrganizationId && membersReachable);

  const options = $derived(list ? scopeOptions(list, directory, serversStore.activeOrganizationId, ownerLabel(list, directory), { membersReachable }) : []);
  const selectedKey = $derived(list ? scopeKey(scopeOf(list)) : "private");
  const selected = $derived(options.find((option) => option.key === selectedKey) ?? options[0]);
  const linkRuns = $derived(list?.link?.role === "editor" || (list?.link?.role === "custom" && !!list.link.actions?.includes("drive.prompt")));
  const consentSentence = $derived(
    target && target.resource.kind !== "work" && linkRuns
      ? "Turns started by guests run under the login of whoever made the link."
      : null,
  );
  /** A custom link's rows, under the general access, while the link is the scope. */
  const customRows = $derived(list?.link?.role === "custom" ? customActionRows(list.link.actions ?? []) : []);
  /** The clock the expiry line reads; it is set when the dialog opens and when the link changes. */
  const openedAt = $derived.by(() => { void list?.link; return Date.now(); });

  async function setLinkAction(leaf: SessionActionLeaf, on: boolean): Promise<void> {
    if (!target || !list?.link || !canShare) return;
    await sharesStore.setLinkAccess(target.serverId, list, { actions: toggledActions(list.link.actions ?? [], leaf, on) });
  }

  async function setLinkLifetime(ms: number | null): Promise<void> {
    if (!target || !list?.link || !canShare) return;
    await sharesStore.setLinkAccess(target.serverId, list, { expiresInMs: ms });
  }
  const kindWord = $derived(target?.resource.kind ?? "session");

  function close(): void {
    sharesStore.close();
    requestInputFocus();
  }

  /** The general-access choice, or a role on it: either way the option becomes the scope, with that role. */
  async function chooseScope(option: ScopeOption, role?: ShareRole): Promise<void> {
    if (!target || !list || !canShare || option.unavailable) return;
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

  const roleLabel = (role: ShareRole | "owner") => (role === "owner" ? "Owner" : role === "editor" ? "Can edit" : role === "commenter" ? "Can comment" : role === "custom" ? "Custom" : "Can view");
  // Only a work has comments and review decisions, so only a work offers a commenter.
  const roleChoices = $derived<readonly ShareRole[]>(target?.resource.kind === "work" ? ["viewer", "commenter", "editor"] : ["viewer", "editor"]);
  // A session's link can also be a custom role: the owner picks what a guest may do (custom-roles.md §4).
  const linkRoleChoices = $derived<readonly ShareRole[]>(target?.resource.kind === "session" ? ["viewer", "custom", "editor"] : roleChoices);

  const linkContext = $derived(target ? sharesStore.linkContext(target.serverId, target.resource) : null);
  /** The link as the host now holds it: always at hand for whoever may share. */
  const link = $derived(list && linkContext ? linkPresentation(list.link, linkContext, canShare, list.resource) : null);
  /** The app's address, which each person opens with their own sign-in. */
  const memberLink = $derived(target ? sharesStore.memberLinkUrl(target.serverId, target.resource) : null);
  /** Copy copies the current scope's link; only the access choice changes who can open it. */
  const copyTarget = $derived(list ? linkToCopy(list, link, memberLink) : null);
  const canCopy = $derived(canShare && !sharesStore.busy && !!copyTarget);

  async function copyLink(): Promise<void> {
    if (!copyTarget || !canCopy) return;
    try {
      await navigator.clipboard.writeText(copyTarget.text);
      copied = true;
      toasts.success(copyTarget.kind === "guest" ? "Link copied · anyone with it can open it" : "Link copied · only people with access can open it");
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

{#snippet roleMenu(current: ShareRole, onSelect: (role: ShareRole) => void, onRemove: (() => void) | null, testId: string, choices: readonly ShareRole[] = roleChoices)}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button {...props} variant="ghost" size="sm" class="shrink-0 gap-1 px-2 text-workspace-chrome font-normal text-foreground aria-expanded:bg-transparent pointer-coarse:h-10" data-testid={testId} disabled={sharesStore.busy}>
          {roleLabel(current)}
          <CaretDownIcon />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" class="w-auto min-w-36" portalProps={menuPortal}>
      {#each choices as role (role)}
        <DropdownMenu.Item onSelect={() => onSelect(role)} data-testid="share-role-choice" data-role={role}>
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
        Sharing puts this {kindWord} in {publication.organizationName} on Solus Cloud, where the people you choose can open it.
      </p>
      {#if publication.status.kind === "failed" || publication.status.kind === "offline"}
        <Button variant="outline" class="mt-2 h-10 self-start rounded-xl px-4" onclick={() => void sharesStore.publish()} data-testid="share-publish-retry">Retry</Button>
      {/if}
    </section>
  {:else if !list}
    <p class="py-6 text-center text-muted-foreground" role="status">Loading who can open it…</p>
  {:else}
    <!-- The two verbs on one line: add a person by name, or copy the link.
         The URL itself never needs to be read, so it is not shown. -->
    {#if canShare}
      <div class="flex items-start gap-3">
        {#if canInvite || peopleLoading}
          <div class="relative min-w-0 flex-1">
            <Input
              bind:value={query}
              placeholder={peopleLoading ? "Loading people…" : "Add people by name or email"}
              aria-label="Add people"
              aria-busy={peopleLoading}
              data-testid="share-add-people"
              class="h-10 rounded-xl bg-muted/40 px-3.5 text-workspace-chrome pointer-coarse:h-11"
              disabled={sharesStore.busy || peopleLoading}
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
                      <span class="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
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
        <Button class="ml-auto h-10 gap-2 rounded-xl px-4 hover:bg-primary/90 pointer-coarse:h-11" onclick={copyLink} disabled={!canCopy} data-testid="share-copy-link" data-link={copyTarget?.text ?? undefined}>
          {#if copied}<CheckIcon class="size-4" />{:else}<CopyIcon class="size-4" />{/if}
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
    {/if}

    <!-- Who has access: the general access first, then the people invited by
         name, the owner first. General access is one choice, widest last. Each
         choice holds the ones before it — the organization has every team, the
         link has everyone — so widening never takes the resource from a group
         that had it. Each choice explains itself in the menu, not on the
         dialog. A person named here keeps their own role whatever general
         access says. -->
    <section class="flex flex-col gap-3" aria-label="Who has access">
      <h3 class="text-muted-foreground">Who has access</h3>
      <ul class="flex flex-col gap-2" data-testid="share-people">
        {#if selected}
          <li class="flex min-h-11 items-center gap-3 pointer-coarse:min-h-12" aria-label="General access">
            <span class="inline-flex size-9 shrink-0 items-center justify-center rounded-xl border-[0.0625rem] border-border bg-muted text-foreground">{@render scopeIcon(selected)}</span>
            <span class="flex min-w-0 flex-1 items-center">
              {#if canShare}
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger>
                    {#snippet child({ props })}
                      <button {...props} type="button" class="-mx-1.5 inline-flex h-8 max-w-full min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-left font-medium text-foreground hover:bg-muted data-[state=open]:bg-transparent disabled:cursor-default pointer-coarse:h-10" title={selected.detail} data-testid="share-scope" data-scope={selected.key} disabled={sharesStore.busy}>
                        <span class="truncate">{selected.name}</span>
                        <CaretDownIcon size={16} class="shrink-0 text-muted-foreground" />
                      </button>
                    {/snippet}
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content align="start" class="w-auto min-w-72 p-1.5" portalProps={menuPortal}>
                    {#each options as option (option.key)}
                      <DropdownMenu.Item onSelect={(event) => { if (option.unavailable) event.preventDefault(); else void chooseScope(option); }} aria-disabled={option.unavailable ? true : undefined} title={option.unavailable} class="h-auto gap-3 py-2 {option.unavailable ? 'opacity-50' : ''}" data-testid="share-scope-option" data-scope={option.key} data-unavailable={option.unavailable ? "true" : undefined}>
                        {@render scopeIcon(option)}
                        <span class="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
                          <span class="truncate">{option.name}</span>
                          <span class="truncate text-[0.875em] text-muted-foreground">{option.unavailable ?? option.detail}</span>
                        </span>
                        {#if option.key === selected.key}<CheckIcon />{/if}
                      </DropdownMenu.Item>
                    {/each}
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              {:else}
                <span class="truncate font-medium text-foreground" title={selected.detail}>{selected.name}</span>
              {/if}
            </span>
            {#if selected.role}
              {#if canShare}
                {@render roleMenu(selected.role, (role) => void chooseScope(selected, role), null, "share-scope-role", selected.scope.kind === "link" ? linkRoleChoices : roleChoices)}
              {:else}
                <span class="mr-2 shrink-0 text-muted-foreground">{roleLabel(selected.role)}</span>
              {/if}
            {/if}
          </li>
        {/if}
        {#if list.link && canShare}
          <!-- The link's own settings: what a custom link lets a guest do, and how long it lasts. -->
          <li class="flex flex-col gap-3 rounded-xl bg-muted/40 px-3.5 py-3" aria-label="Link settings" data-testid="share-link-settings">
            {#if customRows.length > 0}
              <ul class="flex flex-col gap-2.5" aria-label="What anyone with the link can do">
                {#each customRows as item (item.leaf)}
                  <li class="flex items-start gap-3" data-testid="share-link-action" data-action={item.leaf} data-on={item.isOn ? "true" : "false"}>
                    <span class="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
                      <span class="text-foreground">{item.row.label}</span>
                      {#if item.row.detail}<span class="text-pretty text-[0.875em] text-muted-foreground">{item.row.detail}</span>{/if}
                      {#if item.isOn && item.row.warning}
                        <span class="flex items-center gap-1.5 text-[0.875em] text-(--solus-status-permission)" data-testid="share-link-warning"><WarningIcon size={14} class="shrink-0" />{item.row.warning}</span>
                      {/if}
                    </span>
                    <Switch
                      checked={item.isOn}
                      disabled={item.isFixed || sharesStore.busy}
                      onCheckedChange={(next) => void setLinkAction(item.leaf, next)}
                      aria-label={item.row.label}
                    />
                  </li>
                {/each}
              </ul>
            {/if}
            <div class="flex items-center gap-3">
              <span class="min-w-0 flex-1 truncate text-muted-foreground" data-testid="share-link-expiry">{linkExpiryLabel(list.link.expiresAt, openedAt)}</span>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <Button {...props} variant="ghost" size="sm" class="shrink-0 gap-1 px-2 text-workspace-chrome font-normal text-foreground aria-expanded:bg-transparent pointer-coarse:h-10" data-testid="share-link-lifetime" disabled={sharesStore.busy}>
                      Lasts
                      <CaretDownIcon />
                    </Button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end" class="w-auto min-w-36" portalProps={menuPortal}>
                  {#each LINK_LIFETIME_CHOICES as choice (choice.label)}
                    <DropdownMenu.Item onSelect={() => void setLinkLifetime(choice.ms)} data-testid="share-link-lifetime-choice">{choice.label}</DropdownMenu.Item>
                  {/each}
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </div>
          </li>
        {/if}
        {#if !peopleLoaded}
          <li class="flex min-h-11 items-center text-muted-foreground pointer-coarse:min-h-12" role="status">Loading people…</li>
        {:else}
          {#each people as person (person.userId)}
            <li class="flex min-h-11 items-center gap-3 pointer-coarse:min-h-12" data-testid="share-person" data-user-id={person.userId} data-role={person.role}>
              <UserAvatar user={person.user} size={36} />
              <span class="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
                <span class="truncate font-medium text-foreground">{person.user.displayName}{#if person.isSelf}<span class="ml-1 font-normal text-muted-foreground">(you)</span>{/if}</span>
                {#if person.detail}<span class="truncate text-[0.875em] text-muted-foreground">{person.detail}</span>{/if}
              </span>
              {#if person.role === "owner" || !canShare}
                <span class="mr-2 shrink-0 text-muted-foreground">{roleLabel(person.role)}</span>
              {:else}
                {@render roleMenu(person.role, (role) => void setRole(person, role), () => void remove(person), "share-person-role")}
              {/if}
            </li>
          {/each}
        {/if}
      </ul>
      {#if consentSentence}
        <p class="text-pretty text-[0.875em] text-muted-foreground" data-testid="share-consent">{consentSentence}</p>
      {/if}
      {#if canShare && !accountStore.isSignedIn}
        <p class="text-pretty text-[0.875em] text-muted-foreground" data-testid="share-sign-in">Sign in to share with people, a team, or your organization.</p>
      {/if}
      {#if link?.kind === "unreachable"}
        <p class="text-pretty text-[0.875em] text-muted-foreground" data-testid="share-unreachable">Nobody can reach this computer for a link. Link this computer under Connections, or use Tailscale. A link never goes over a plain network address, where anyone on the network could read it.</p>
      {:else if link?.kind === "unavailable"}
        <p class="text-pretty text-[0.875em] text-muted-foreground">This old link cannot be copied. Choose another access, then the link again, to get a new one.</p>
      {/if}
    </section>
  {/if}
{/snippet}

{#if target}
  {#if useSheet}
    <BottomSheet label={`Share ${target.title}`} onClose={close}>
      {#snippet header()}
        <span class="min-w-0 truncate font-semibold text-foreground">Share {target.title}</span>
      {/snippet}
      <div class="flex flex-col gap-6 pb-4">{@render dialogBody()}</div>
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
      <!-- No title bar and no footer: the dialog opens on its two verbs, and
           Escape or a click outside closes it. -->
      <div
        class="share-dialog-enter flex max-h-[min(38rem,80svh)] w-[clamp(24rem,44vw,34rem)] max-w-[calc(100vw-3rem)] origin-top flex-col overflow-hidden rounded-3xl border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) text-workspace-chrome shadow-[shadow:var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.24),0_4.375rem_8.125rem_-3.125rem_rgba(0,0,0,0.34)] [.dark_&]:shadow-[shadow:var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.06),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.45),0_4.375rem_8.125rem_-3.125rem_rgba(0,0,0,0.55)]"
        role="dialog"
        aria-label={`Share ${target.title}`}
        aria-modal="true"
        data-testid="share-dialog"
        data-kind={target.resource.kind}
        bind:this={dialogEl}
      >
        <div class="flex flex-col gap-6 overflow-y-auto p-6">{@render dialogBody()}</div>
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
