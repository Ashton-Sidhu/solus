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
  import { ANOTHER_ADDRESS_KEY, ANOTHER_SSH_KEY, approveSteps, codeSteps, reachableMachines, stepTextParts, wayLabel } from "./lib/add-machine-card";
  import { AddMachineCardState } from "./lib/add-machine-card.svelte";
  import { settingsSyncStore } from "../../contexts/app/settings-sync.store.svelte";
  import SyncSettingsCheckbox from "../connections/SyncSettingsCheckbox.svelte";

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
  const isAddressRow = $derived(card.selectedKey === ANOTHER_ADDRESS_KEY);
  const canEnterCode = $derived(!card.showsCodeField && (isAddressRow || selected?.way === "approve" || !!selected?.minted));
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
    if (selected?.serverId) shell.openResource({ kind: "connections", serverId: selected.serverId, tab: "access", pair: true });
  }

  function addLabel(): string {
    if (card.failure) return "Try again";
    return selected?.way === "approve" && !card.useCode ? "Ask to approve" : `Add ${name}`;
  }
</script>

<!-- A line of steps: a command in backticks shows as code. -->
<!-- One line, so no space comes between a command and the stop after it. -->
{#snippet stepText(text: string)}{#each stepTextParts(text) as part, index (index)}{#if part.isCode}<code class="rounded-sm bg-(--solus-surface-hover) px-1 font-mono text-[0.95em] text-(--solus-text-secondary)">{part.text}</code>{:else}{part.text}{/if}{/each}{/snippet}

<!-- The approval request waits on the target's owner: the check code is what they compare. -->
{#snippet approvalCode(step: StatusCardStep)}
  {#if step.id === "approve" && step.status === "active" && card.approval}
    <li class="pr-2 pb-2 pl-[1.875rem]">
      <div class="flex flex-wrap items-center gap-x-3.5 gap-y-2 rounded-lg bg-(--solus-surface-hover) px-3.5 py-3">
        <code class="shrink-0 font-mono text-[1.375rem] leading-none font-medium tracking-[0.08em] whitespace-nowrap text-(--solus-text-primary) tabular-nums">{card.approval.checkCode}</code>
        <p class="m-0 min-w-48 flex-1 text-transcript-meta text-pretty text-(--muted-foreground)">
          {@render stepText(approveSteps(name, card.approval.checkCode))}
          <span class="whitespace-nowrap tabular-nums">{countdown(card.approval.expiresAt - now)} left</span>
        </p>
      </div>
    </li>
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
          {#each candidates as candidate, index (candidate.key)}
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
                <span class="flex min-w-0 items-center gap-1.5">
                  <span class={["truncate text-[0.8125rem] font-medium", isSelected ? "text-(--solus-text-primary)" : "text-(--solus-text-secondary) group-hover:text-(--solus-text-primary)"]}>{candidate.label}</span>
                  {#if index === 0 && candidate.isMatch}
                    <span class="shrink-0 rounded-full bg-(--solus-accent-soft) px-1.5 text-[0.6875rem] leading-4 font-medium text-(--solus-accent)">Best match</span>
                  {/if}
                </span>
                <span class="truncate font-mono text-[0.6875rem] text-(--muted-foreground)">{candidate.detail}</span>
              </span>
              <span class="shrink-0 text-[0.6875rem] text-(--muted-foreground)">{wayLabel(candidate)}</span>
            </div>
          {/each}
          <div
            id="{idBase}-{ANOTHER_SSH_KEY}"
            role="option"
            tabindex="-1"
            aria-selected={card.isSshTargetRow}
            class={["group flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5", card.isSshTargetRow && "bg-(--solus-surface-hover) shadow-[inset_0_0_0_0.03125rem_color-mix(in_oklch,var(--foreground)_14%,transparent)]"]}
            onclick={() => card.select(ANOTHER_SSH_KEY)}
            onkeydown={onListKey}
          >
            <span class="flex size-7 shrink-0 items-center justify-center rounded-lg text-(--muted-foreground) shadow-[inset_0_0_0_0.0625rem_color-mix(in_oklch,var(--foreground)_14%,transparent)]" aria-hidden="true">
              <TerminalIcon size={14} />
            </span>
            <span class={["min-w-0 flex-1 truncate text-[0.8125rem]", card.isSshTargetRow ? "font-medium text-(--solus-text-primary)" : "text-(--muted-foreground) group-hover:text-(--solus-text-primary)"]}>Another machine over SSH…</span>
          </div>
          <div
            id="{idBase}-{ANOTHER_ADDRESS_KEY}"
            role="option"
            tabindex="-1"
            aria-selected={isAddressRow}
            class={["group flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5", isAddressRow && "bg-(--solus-surface-hover) shadow-[inset_0_0_0_0.03125rem_color-mix(in_oklch,var(--foreground)_14%,transparent)]"]}
            onclick={() => card.select(ANOTHER_ADDRESS_KEY)}
            onkeydown={onListKey}
          >
            <span class="flex size-7 shrink-0 items-center justify-center rounded-lg text-(--muted-foreground) shadow-[inset_0_0_0_0.0625rem_color-mix(in_oklch,var(--foreground)_14%,transparent)]" aria-hidden="true">
              <PlusIcon size={14} />
            </span>
            <span class={["min-w-0 flex-1 truncate text-[0.8125rem]", isAddressRow ? "font-medium text-(--solus-text-primary)" : "text-(--muted-foreground) group-hover:text-(--solus-text-primary)"]}>Another address…</span>
          </div>
        </div>

        {#if isAddressRow}
          <div class="flex min-w-0 flex-col gap-1">
            <label for="{idBase}-address" class="text-transcript-meta text-(--muted-foreground)">Address or pair link</label>
            <Input
              id="{idBase}-address"
              bind:value={card.address}
              dictation={false}
              spellcheck={false}
              autocomplete="off"
              placeholder="10.10.1.10, or paste a pair link"
              disabled={closed || isBusy}
              aria-invalid={failureAt === "address"}
              class="h-8 font-mono text-xs"
            />
            {#if failureAt === "address" && showsFieldMessage}<p role="alert" class="m-0 text-transcript-meta text-(--solus-status-error)">{card.failure?.message}</p>{/if}
          </div>
        {/if}

        {#if card.isSshTargetRow}
          <div class="flex min-w-0 flex-col gap-1">
            <label for="{idBase}-ssh-target" class="text-transcript-meta text-(--muted-foreground)">Target</label>
            <Input
              id="{idBase}-ssh-target"
              bind:value={card.sshTarget}
              dictation={false}
              spellcheck={false}
              autocomplete="off"
              placeholder="ubuntu@3.91.20.4"
              disabled={closed || isBusy}
              aria-invalid={failureAt === "target"}
              class="h-8 font-mono text-xs"
            />
            {#if failureAt === "target" && showsFieldMessage}<p role="alert" class="m-0 text-transcript-meta text-(--solus-status-error)">{card.failure?.message}</p>{/if}
          </div>
        {/if}

        {#if selected?.way === "ssh" && !card.isKeyFieldOpen}
          <p class="m-0 flex min-w-0 flex-wrap items-center gap-x-1.5 text-transcript-meta text-(--muted-foreground)">
            <span>Key: from ~/.ssh/config</span>
            <span aria-hidden="true">·</span>
            <button type="button" class="interrupt-link" disabled={closed || isBusy} onclick={openKeyField}>Use another key…</button>
          </p>
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
            {#if !card.isSshTargetRow}
              <button type="button" class="interrupt-link w-fit" disabled={closed || isBusy} onclick={() => card.closeKeyField()}>Use the key from ~/.ssh/config</button>
            {/if}
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
            <p id="{idBase}-code-steps" class="m-0 text-transcript-meta text-pretty text-(--muted-foreground)">{@render stepText(codeSteps(name))}</p>
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

        {#if !closed && !isBusy}
          <SyncSettingsCheckbox />
        {/if}

        {#if canEnterCode}
          <button type="button" class="interrupt-link w-fit" disabled={closed || isBusy} onclick={() => card.enterCode()}>Enter a code instead</button>
        {/if}
      {/if}
    </form>
    {#snippet footer()}
      {#if !request.expired}
        <div class="flex min-w-0 items-center justify-end gap-1">
          <span class="interrupt-key mr-auto truncate" aria-hidden="true">↑↓ pick · ↵ add</span>
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
