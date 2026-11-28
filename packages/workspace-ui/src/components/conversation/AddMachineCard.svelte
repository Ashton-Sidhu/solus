<script lang="ts">
  /** The Add machine card of `add_host` (docs/plans/add-machine-card.md). The
   *  person picks a machine and clicks Add once; the card does the work on the
   *  session's host (an SSH add, an approval request, or a pairing code), then
   *  answers the card with the outcome only. A typed code or password lives
   *  only in this card's state and goes to the host once, in that call. */
  import { tick } from "svelte";
  import { ArrowUpRight as ArrowUpRightIcon, KeyRound as KeyIcon, Plus as PlusIcon, Terminal as TerminalIcon } from "@lucide/svelte";
  import { rankAddMachineCandidates } from "@solus/client-core/add-machine-candidates";
  import { defaultDeviceLabel } from "@solus/client-core/device-label";
  import { serverFromSshAdd } from "@solus/client-core/known-host";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { unencryptedPasswordMessage } from "@solus/client-core/ssh-password";
  import type { SshTargetCandidate } from "@solus/contracts/remote-machines";
  import type { QuestionRequest, StatusCardStep } from "@solus/contracts/types";
  import { getClientShellContext, getWorkspaceContext, serversStore } from "../../contexts";
  import { discoveredServerUrl } from "../../contexts/connections/discovery";
  import { hosts } from "../../contexts/hosts/hosts.svelte";
  import { canDriveSession } from "../../contexts/sharing/resource-roles";
  import { runHost } from "../../contexts/workspace/run-location";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { liveActivityClock } from "../../lib/shared-clock";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import InterruptCard from "./InterruptCard.svelte";
  import StatusCard from "./StatusCard.svelte";
  import HostOperatingSystemIcon from "../servers/HostOperatingSystemIcon.svelte";
  import DirectoryPicker from "../pickers/DirectoryPicker.svelte";
  import { countdown } from "../../lib/countdown";
  import { pairCodeSteps } from "@solus/client-core/pairing";
  import { stepTextParts } from "../../lib/step-text";
  import { approveSteps, OTHER_MACHINE_KEY, reachableMachines, wayLabel } from "./lib/add-machine-card";
  import { AddMachineCardState } from "./lib/add-machine-card.svelte";
  import { settingsSyncStore } from "../../contexts/app/settings-sync.store.svelte";
  import { Switch } from "../ui/switch";

  interface Props {
    tabId: string;
    request: QuestionRequest;
    /** Answers another session's card. Unset, the answer goes to this tab's session. */
    answer?: (questionId: string, answers: Record<string, string>) => Promise<boolean>;
  }
  let { tabId, request, answer }: Props = $props();

  const session = getWorkspaceContext();
  const shell = getClientShellContext();
  const sess = $derived(session.sessionFor(tabId));
  const sessionHostId = $derived(runHost(sess?.run) ?? "");
  const canDrive = $derived(canDriveSession(runHost(sess?.run), sess?.id, "drive.approve"));
  const ask = $derived(request.hostLink ?? { reason: "The agent asks to add a machine." });
  const idBase = $derived(`add-machine-${request.questionId}`);
  const sessionHostName = $derived(serversStore.hostFor(sessionHostId)?.label || "the session's host");

  // The session host's SSH targets: read once, an empty list when it cannot say.
  let sshTargets = $state<SshTargetCandidate[]>([]);
  $effect(() => {
    let isCurrent = true;
    session.apiFor(tabId).hostsListSshConfigHosts()
      .then((targets) => { if (isCurrent) sshTargets = targets; })
      .catch(() => {});
    return () => { isCurrent = false; };
  });

  const candidates = $derived(rankAddMachineCandidates(ask, {
    reachable: reachableMachines(
      serversStore.servers.map((server) => ({
        id: server.id,
        label: server.label,
        routes: server.routes,
        principal: server.readiness === "ready" ? hosts.get(server.id)?.me.principal : undefined,
        os: server.os,
      })),
      sessionHostId,
    ),
    ssh: sshTargets,
    nearby: serversStore.nearbyHosts.map((host) => ({ label: host.server.name || host.server.host, url: discoveredServerUrl(host.server) })),
  }));

  async function answerCard(answers: Record<string, string>): Promise<boolean> {
    const answered = answer
      ? await answer(request.questionId, answers)
      : await session.controls.respondQuestion(tabId, request.questionId, answers);
    if (answered) requestInputFocus({ tabId });
    return answered;
  }

  settingsSyncStore.startAdd();
  const card = new AddMachineCardState({
    candidates: () => candidates,
    ask: () => ask,
    addOverSsh: (sshRequest) => session.apiFor(tabId).hostsAddOverSsh(sshRequest),
    pair: (pairRequest) => session.apiFor(tabId).hostsPair(pairRequest),
    watchSshProgress: (requestId, onProgress) =>
      serverConnections.eventsFor(sessionHostId).subscribe("host.sshProgress", (event) => {
        if (event.requestId === requestId) onProgress(event);
      }),
    mint: async (serverId) => (await serverConnections.apiFor(serverId).connectionsGeneratePairToken()).code,
    answer: answerCard,
    passwordIssue: () =>
      serverConnections.hasEncryptedConnection(sessionHostId)
        ? ""
        : unencryptedPasswordMessage(sessionHostName),
    afterSshAdd: async (result) => {
      // A forward held by this computer is one this client can dial too.
      if (result.status === "forwarded" && sessionHostId === hosts.device?.id) await serversStore.savePairedServer(serverFromSshAdd(result, null));
      else if (result.status === "linked") void serversStore.refreshDirectory();
    },
    deviceLabel: defaultDeviceLabel,
    noticeAdded: (label, hostId) => {
      // Signed out, the new host takes the person's server settings when the card's Sync settings is on.
      settingsSyncStore.hostAdded(hostId, sessionHostId);
      toasts.success(`${label} is added`);
    },
  });

  const closed = $derived(!!request.expired || card.phase === "closed" || !canDrive);
  const isBusy = $derived(card.phase !== "choose");
  // While an add runs, and once it is done, the card is the setup card a run's setup draws.
  const isAdding = $derived(!request.expired && card.phase !== "choose" && card.phase !== "closed" && !!card.statusCard);
  // A failed add shows where it stopped above the choice, so the message is not also at the field.
  const showsFieldMessage = $derived(!card.statusCard);
  const selected = $derived(card.selected);
  const name = $derived(card.machineName);
  // A code is the way back from an approval request, and the way past a code this device makes.
  const canEnterCode = $derived(!card.showsCodeField && (card.useApproval || !!selected?.minted));
  // "Use another key…" shows once the row names an SSH target.
  const offersAnotherKey = $derived(!card.isKeyFieldOpen && (selected?.way === "ssh" || (card.isSshTargetRow && !!card.otherMachine.trim())));
  const showsPassword = $derived(card.isPasswordAsked && !!card.selectedSshTarget);
  const failureAt = $derived(card.failure?.field);

  let now = $state(Date.now());
  $effect(() => {
    if (!card.approval) return;
    now = Date.now();
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  function onListKey(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      card.move(event.key);
    } else if (event.key === "Enter") {
      event.preventDefault();
      void card.add();
    }
  }

  // The key is a file on the session's host, which runs SSH, so the picker browses that host.
  let identityInput: HTMLInputElement | null = $state(null);
  let isKeyPickerOpen = $state(false);

  let otherMachineInput: HTMLInputElement | null = $state(null);

  // A click on "Other machine…" means typing comes next; arrow keys keep focus on the list.
  function chooseOtherMachine() {
    card.select(OTHER_MACHINE_KEY);
    void tick().then(() => otherMachineInput?.focus());
  }

  function focusIdentityInput() {
    void tick().then(() => identityInput?.focus());
  }

  function openKeyField() {
    card.openKeyField();
    focusIdentityInput();
  }

  function closeKeyPicker() {
    isKeyPickerOpen = false;
    focusIdentityInput();
  }

  function chooseKey(path: string) {
    card.identityFile = path;
    closeKeyPicker();
  }

  function showCodeOnTarget() {
    if (selected?.serverId) shell.openResource({ kind: "connections", serverId: selected.serverId, pair: true });
  }

  function addLabel(): string {
    if (card.failure) return "Try again";
    return "Add";
  }
</script>

<!-- A line of steps: a command in backticks shows as code. -->
<!-- One line, so no space comes between a command and the stop after it. -->
{#snippet stepText(text: string)}{#each stepTextParts(text) as part, index (index)}{#if part.isCode}<code class="rounded-sm bg-(--solus-surface-hover) px-1 font-mono text-[0.95em] text-(--solus-text-secondary)">{part.text}</code>{:else}{part.text}{/if}{/each}{/snippet}

<!-- The approval request waits on the target's owner: the check code is what they compare. -->
{#snippet approvalCode(step: StatusCardStep)}
  {#if step.id === "approve" && step.status === "active" && card.approval}
    <!-- On the step itself, under its title: the code to compare, then what to do. -->
    <div class="mt-1 flex flex-col gap-0.5">
      <code class="font-mono text-[1.125rem] leading-7 font-medium tracking-[0.08em] whitespace-nowrap text-(--solus-text-primary) tabular-nums">{card.approval.checkCode}</code>
      <p class="m-0 text-transcript-meta text-pretty text-(--muted-foreground)">
        {@render stepText(approveSteps(name, card.approval.checkCode))}
        <span class="whitespace-nowrap tabular-nums">{countdown(card.approval.expiresAt - now)} left</span>
      </p>
    </div>
  {/if}
{/snippet}

{#if isAdding && card.statusCard}
  <StatusCard card={card.statusCard} stepAddon={approvalCode} />
{:else}
  {#if card.statusCard && !request.expired}
    <StatusCard card={card.statusCard} />
  {/if}
  <InterruptCard type="question" title="Add a machine" testId="add-machine-card">
    <form
      id="{idBase}-form"
      class="flex min-w-0 flex-col gap-3"
      autocomplete="off"
      onsubmit={(event) => { event.preventDefault(); void card.add(); }}
    >
      <p class="interrupt-title m-0 wrap-anywhere">{ask.reason}</p>

      {#if request.expired}
        <p class="m-0 text-transcript-meta text-(--muted-foreground)">This request is closed.</p>
      {:else}
        <!-- One list, one selection: arrows move it, Enter adds. -->
        <div
          class="-mx-1.5 flex flex-col gap-0.5 rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-tx-focus-ring)"
          role="listbox"
          tabindex={closed ? -1 : 0}
          aria-label="Machines"
          aria-activedescendant="{idBase}-{card.selectedKey}"
          aria-disabled={closed || isBusy}
          onkeydown={onListKey}
        >
          {#each candidates as candidate (candidate.key)}
            {@const isSelected = candidate.key === card.selectedKey}
            <div
              id="{idBase}-{candidate.key}"
              role="option"
              tabindex="-1"
              aria-selected={isSelected}
              class={["group flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5", isSelected && "bg-(--solus-surface-hover) shadow-[inset_0_0_0_0.03125rem_color-mix(in_oklch,var(--foreground)_14%,transparent)]"]}
              onclick={() => card.select(candidate.key)}
              onkeydown={onListKey}
            >
              <!-- The machine's mark: its operating system, or a terminal for an SSH target. -->
              <span class={["flex size-7 shrink-0 items-center justify-center rounded-lg bg-(--solus-tx-card-bg) shadow-(--solus-tx-hairline)", isSelected ? "text-(--solus-text-primary)" : "text-(--muted-foreground)"]} aria-hidden="true">
                {#if candidate.way === "ssh"}<TerminalIcon size={15} />{:else}<HostOperatingSystemIcon os={candidate.os} size={15} />{/if}
              </span>
              <span class="flex min-w-0 flex-1 flex-col">
                <!-- Weight marks the selection: the selected machine is medium, the others regular. -->
                <span class={["truncate text-[0.8125rem]", isSelected ? "font-medium text-(--solus-text-primary)" : "text-(--solus-text-secondary) group-hover:text-(--solus-text-primary)"]}>{candidate.label}</span>
                <!-- The way sits beside the address, so a row reads as one unit at any card width. -->
                <span class="flex min-w-0 items-baseline gap-1.5 text-[0.6875rem] text-(--muted-foreground)">
                  <span class="truncate font-mono">{candidate.detail}</span>
                  <span class="shrink-0" aria-hidden="true">·</span>
                  <span class="shrink-0">{wayLabel(candidate)}</span>
                </span>
              </span>
            </div>
          {/each}
          <div
            id="{idBase}-{OTHER_MACHINE_KEY}"
            role="option"
            tabindex="-1"
            aria-selected={card.isOtherRow}
            class={["group flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5", card.isOtherRow && "bg-(--solus-surface-hover) shadow-[inset_0_0_0_0.03125rem_color-mix(in_oklch,var(--foreground)_14%,transparent)]"]}
            onclick={chooseOtherMachine}
            onkeydown={onListKey}
          >
            <span class="flex size-7 shrink-0 items-center justify-center rounded-lg text-(--muted-foreground) shadow-[inset_0_0_0_0.0625rem_color-mix(in_oklch,var(--foreground)_14%,transparent)]" aria-hidden="true">
              <PlusIcon size={14} />
            </span>
            <span class={["min-w-0 flex-1 truncate text-[0.8125rem]", card.isOtherRow ? "font-medium text-(--solus-text-primary)" : "text-(--muted-foreground) group-hover:text-(--solus-text-primary)"]}>Other machine…</span>
          </div>
        </div>

        {#if card.isOtherRow}
          <!-- One field: an SSH target, or a Solus address or pair link. The way it is read shows at its end. -->
          <div class="flex min-w-0 flex-col gap-1">
            <div class="relative min-w-0">
              <Input
                id="{idBase}-other-machine"
                bind:ref={otherMachineInput}
                bind:value={card.otherMachine}
                dictation={false}
                spellcheck={false}
                autocomplete="off"
                aria-label="SSH target or address"
                placeholder="user@host, or http://host:port"
                disabled={closed || isBusy}
                aria-invalid={failureAt === "target" || failureAt === "address"}
                class="h-8 pr-16 font-mono text-xs"
              />
              {#if card.otherMachine.trim()}
                <span class="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[0.6875rem] text-(--muted-foreground)">{card.isAddressRow ? "Address" : "SSH"}</span>
              {/if}
            </div>
            {#if (failureAt === "target" || failureAt === "address") && showsFieldMessage}<p role="alert" class="m-0 text-transcript-meta text-pretty text-(--solus-status-error)">{card.failure?.message}</p>{/if}
          </div>
        {/if}


        {#if card.showsKeyField}
          <div class="flex min-w-0 flex-col gap-1">
            <label for="{idBase}-identity-file" class="text-transcript-meta text-(--muted-foreground)">Identity file (optional)</label>
            <div class="flex min-w-0 gap-1.5">
              <Input
                id="{idBase}-identity-file"
                bind:ref={identityInput}
                bind:value={card.identityFile}
                dictation={false}
                spellcheck={false}
                autocomplete="off"
                placeholder="~/.ssh/my-key.pem"
                disabled={closed || isBusy}
                aria-invalid={failureAt === "identity"}
                aria-describedby="{idBase}-identity-file-hint"
                class="h-8 min-w-0 flex-1 font-mono text-xs"
              />
              <Button size="sm" variant="outline" class="h-8 shrink-0" disabled={closed || isBusy || !sessionHostId} onclick={() => (isKeyPickerOpen = true)}>Browse…</Button>
            </div>
            {#if failureAt === "identity"}<p role="alert" class="m-0 text-transcript-meta text-pretty text-(--solus-status-error)">{card.failure?.message}</p>{/if}
            <p id="{idBase}-identity-file-hint" class="m-0 text-transcript-meta text-pretty text-(--muted-foreground)">
              A private key on {sessionHostName}, as with ssh -i. Empty: its SSH keys and ~/.ssh/config.
            </p>
            <button type="button" class="interrupt-link w-fit" disabled={closed || isBusy} onclick={() => card.closeKeyField()}>Use the key from ~/.ssh/config</button>
          </div>
        {/if}

        {#if card.keyPermissions}
          <div role="alert" class="flex min-w-0 flex-col items-start gap-2 rounded-lg bg-(--solus-surface-hover) px-3 py-2.5">
            <p class="m-0 text-transcript-meta text-pretty text-(--solus-text-secondary)">{card.keyPermissions.message}</p>
            <Button size="sm" variant="outline" disabled={closed || isBusy} onclick={() => void card.fixKeyPermissions()}>
              Fix permissions
            </Button>
          </div>
        {/if}

        {#if card.showsCodeField}
          <div class="flex min-w-0 flex-col gap-1.5">
            <label for="{idBase}-code" class="text-transcript-meta text-(--muted-foreground)">Pairing code from {name}</label>
            <Input
              id="{idBase}-code"
              bind:value={card.code}
              dictation={false}
              spellcheck={false}
              autocomplete="one-time-code"
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              placeholder="000000, or paste a pair link"
              disabled={closed || isBusy}
              aria-invalid={failureAt === "code"}
              aria-describedby="{idBase}-code-steps"
              class="h-8 font-mono text-sm tracking-[0.2em] placeholder:tracking-normal"
            />
            {#if failureAt === "code" && showsFieldMessage}<p role="alert" class="m-0 text-transcript-meta text-(--solus-status-error)">{card.failure?.message}</p>{/if}
            <p id="{idBase}-code-steps" class="m-0 text-transcript-meta text-pretty text-(--muted-foreground)">{@render stepText(pairCodeSteps(name))}{#if failureAt !== "code"} With no code, Add first tries to join without one.{/if}</p>
            {#if selected?.serverId}
              <button type="button" class="interrupt-link inline-flex w-fit items-center gap-1" onclick={showCodeOnTarget}>
                Show the code on {name}<ArrowUpRightIcon size={14} />
              </button>
            {/if}
          </div>
        {/if}

        {#if showsPassword}
          <div class="flex min-w-0 flex-col gap-1">
            <label for="{idBase}-password" class="flex items-center gap-1.5 text-transcript-meta text-(--muted-foreground)">
              <KeyIcon size={14} class="shrink-0" />SSH password or key passphrase for {card.selectedSshTarget}
            </label>
            <Input
              id="{idBase}-password"
              type="password"
              bind:value={card.password}
              dictation={false}
              autocomplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              disabled={closed || isBusy}
              aria-invalid={failureAt === "password"}
              class="h-8 text-xs"
            />
            {#if failureAt === "password" && showsFieldMessage}<p role="alert" class="m-0 text-transcript-meta text-(--solus-status-error)">{card.failure?.message}</p>{/if}
            <p class="m-0 text-transcript-meta text-(--muted-foreground)">It goes to the session's host once and is not saved.</p>
          </div>
        {/if}

        {#if failureAt === "general" && showsFieldMessage}
          <p role="alert" class="m-0 text-transcript-meta text-(--solus-status-error)">{card.failure?.message}</p>
        {/if}

        {#if card.useApproval}
          <p class="m-0 text-transcript-meta text-pretty text-(--muted-foreground)">Add sends {name} a request. Somebody at {name} approves it in Solus there.</p>
        {/if}

        {#if canEnterCode}
          <button type="button" class="interrupt-link w-fit" disabled={closed || isBusy} onclick={() => card.enterCode()}>Enter a code instead</button>
        {/if}
        {#if card.canAskApproval && card.showsCodeField}
          <!-- The one way that needs somebody at the target: offered, never chosen alone. -->
          <button type="button" class="interrupt-link w-fit" disabled={closed || isBusy} onclick={() => card.askApproval()}>Ask {name} to approve instead</button>
        {/if}
      {/if}
    </form>
    {#snippet footer()}
      {#if !request.expired}
        <div class="flex min-w-0 items-center justify-end gap-1">
          <div class="mr-auto flex min-w-0 items-center gap-3">
            <!-- The config's key is the default; another key is one click away, not a line of its own. -->
            {#if offersAnotherKey && !closed && !isBusy}
              <button type="button" class="interrupt-link min-w-0 truncate" onclick={openKeyField}>Use another key…</button>
            {/if}
            <span class="interrupt-key truncate" aria-hidden="true">↑↓ pick · ↵ add</span>
          </div>
          <!-- Signed out, the new host takes this person's settings (docs/plans/settings-sync-hosts.md). Signed in, the account keeps every host the same. -->
          {#if !settingsSyncStore.isSignedIn && !closed && !isBusy}
            <label
              class="mr-1.5 flex shrink-0 cursor-pointer items-center gap-1.5 text-transcript-meta text-(--muted-foreground)"
              title="Copy your settings to the new host, and keep them the same on your hosts."
            >
              <Switch size="sm" checked={settingsSyncStore.copyOnAdd} onCheckedChange={(checked) => (settingsSyncStore.copyOnAdd = checked)} />
              Sync settings
            </label>
          {/if}
          <Button size="sm" variant="ghost" disabled={closed || isBusy} onclick={() => void card.decline()}>Decline</Button>
          <Button size="sm" type="submit" form="{idBase}-form" disabled={closed || isBusy} class="min-w-0 max-w-64">
            <span class="truncate">{addLabel()}</span>
          </Button>
        </div>
      {/if}
    {/snippet}
  </InterruptCard>
{/if}

{#if isKeyPickerOpen && sessionHostId}
  <DirectoryPicker
    open={isKeyPickerOpen}
    onClose={closeKeyPicker}
    onSelect={chooseKey}
    initialPath="~/.ssh/"
    title="Choose an identity file"
    actionLabel="Choose"
    chooses={(entry) => !entry.isDir}
    api={session.apiFor(tabId)}
    hostLabel={sessionHostName}
    serverId={sessionHostId}
  />
{/if}
