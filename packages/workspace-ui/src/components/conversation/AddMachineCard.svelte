<script lang="ts">
  /** The Add machine card of `add_host` (docs/plans/add-machine-card.md). The
   *  person picks a machine and clicks Add once; the card does the work on the
   *  session's host (an SSH add, an approval request, or a pairing code), then
   *  answers the card with the outcome only. A typed code or password lives
   *  only in this card's state and goes to the host once, in that call. */
  import { ArrowUpRight as ArrowUpRightIcon, KeyRound as KeyIcon, ShieldCheck as ShieldIcon } from "@lucide/svelte";
  import { rankAddMachineCandidates } from "@solus/client-core/add-machine-candidates";
  import { defaultDeviceLabel } from "@solus/client-core/device-label";
  import { serverFromSshAdd } from "@solus/client-core/known-host";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { unencryptedPasswordMessage } from "@solus/client-core/ssh-password";
  import type { SshTargetCandidate } from "@solus/contracts/remote-machines";
  import type { QuestionRequest } from "@solus/contracts/types";
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
  import { countdown } from "../../lib/countdown";
  import { ANOTHER_ADDRESS_KEY, approveSteps, codeSteps, reachableMachines, targetName, wayLabel } from "./lib/add-machine-card";
  import { AddMachineCardState } from "./lib/add-machine-card.svelte";

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

  const card = new AddMachineCardState({
    candidates: () => candidates,
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
        : unencryptedPasswordMessage(serversStore.hostFor(sessionHostId)?.label || "the session's host"),
    afterSshAdd: async (result) => {
      // A forward held by this computer is one this client can dial too.
      if (result.status === "forwarded" && sessionHostId === hosts.device?.id) await serversStore.savePairedServer(serverFromSshAdd(result, null));
      else if (result.status === "linked") void serversStore.refreshDirectory();
    },
    deviceLabel: defaultDeviceLabel,
    noticeAdded: (label) => toasts.success(`${label} is added`),
  });

  const closed = $derived(!!request.expired || card.phase === "closed" || !canDrive);
  const isBusy = $derived(card.phase !== "choose");
  const selected = $derived(card.selected);
  const name = $derived(targetName(selected, card.address));
  const isAddressRow = $derived(card.selectedKey === ANOTHER_ADDRESS_KEY);
  const canEnterCode = $derived(!card.showsCodeField && (isAddressRow || selected?.way === "approve" || !!selected?.minted));
  const showsPassword = $derived(card.isPasswordAsked && selected?.way === "ssh");
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

  function showCodeOnTarget() {
    if (selected?.serverId) shell.openResource({ kind: "connections", serverId: selected.serverId, tab: "access", pair: true });
  }

  function addLabel(): string {
    if (card.phase !== "sending") return selected?.way === "approve" && !card.useCode ? "Ask to approve" : "Add";
    if (card.approval) return "Waiting…";
    return "Adding…";
  }
</script>

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
    {:else if card.phase === "added"}
      <p class="m-0 text-transcript-meta text-(--solus-text-secondary)" role="status">{card.addedLabel} is added.</p>
    {:else if card.approval}
      <!-- The approval request waits on the target's owner: the check code is what they compare. -->
      <div class="flex flex-col items-start gap-2 rounded-lg bg-(--solus-surface-hover) px-3 py-3" role="status" aria-live="polite">
        <span class="flex items-center gap-1.5 text-transcript-meta text-(--muted-foreground)">
          <ShieldIcon size={14} class="shrink-0" />
          Waiting for {name} · {countdown(card.approval.expiresAt - now)}
        </span>
        <code class="font-mono text-[1.75em] leading-none font-medium tracking-[0.08em] text-(--solus-text-primary) tabular-nums">{card.approval.checkCode}</code>
        <p class="m-0 text-transcript-meta text-pretty text-(--muted-foreground)">{approveSteps(name, card.approval.checkCode)}</p>
      </div>
    {:else}
      <!-- One list, one selection: arrows move it, Enter adds. -->
      <div
        class="-mx-2 flex flex-col gap-0.5 rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-tx-focus-ring)"
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
            class={["group flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5", isSelected && "bg-(--solus-surface-hover)"]}
            onclick={() => card.select(candidate.key)}
            onkeydown={onListKey}
          >
            <span class={["flex size-4 shrink-0 items-center justify-center rounded-full", isSelected ? "bg-(--primary)" : "shadow-[inset_0_0_0_0.09375rem_color-mix(in_oklch,var(--foreground)_24%,transparent)]"]} aria-hidden="true">
              {#if isSelected}<span class="size-1.5 rounded-full bg-(--primary-foreground)"></span>{/if}
            </span>
            <span class="flex min-w-0 flex-1 flex-col">
              <span class={["truncate text-xs font-medium", isSelected ? "text-(--solus-text-primary)" : "text-(--solus-text-secondary) group-hover:text-(--solus-text-primary)"]}>{candidate.label}</span>
              <span class="truncate font-mono text-[0.6875rem] text-(--muted-foreground)">{candidate.detail}</span>
            </span>
            <span class="shrink-0 text-[0.6875rem] text-(--muted-foreground)">{wayLabel(candidate)}</span>
          </div>
        {/each}
        <div
          id="{idBase}-{ANOTHER_ADDRESS_KEY}"
          role="option"
          tabindex="-1"
          aria-selected={isAddressRow}
          class={["group flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5", isAddressRow && "bg-(--solus-surface-hover)"]}
          onclick={() => card.select(ANOTHER_ADDRESS_KEY)}
          onkeydown={onListKey}
        >
          <span class={["flex size-4 shrink-0 items-center justify-center rounded-full", isAddressRow ? "bg-(--primary)" : "shadow-[inset_0_0_0_0.09375rem_color-mix(in_oklch,var(--foreground)_24%,transparent)]"]} aria-hidden="true">
            {#if isAddressRow}<span class="size-1.5 rounded-full bg-(--primary-foreground)"></span>{/if}
          </span>
          <span class={["min-w-0 flex-1 truncate text-xs font-medium", isAddressRow ? "text-(--solus-text-primary)" : "text-(--solus-text-secondary) group-hover:text-(--solus-text-primary)"]}>Another address…</span>
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
          {#if failureAt === "address"}<p role="alert" class="m-0 text-transcript-meta text-(--solus-status-error)">{card.failure?.message}</p>{/if}
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
          {#if failureAt === "code"}<p role="alert" class="m-0 text-transcript-meta text-(--solus-status-error)">{card.failure?.message}</p>{/if}
          <p id="{idBase}-code-steps" class="m-0 text-transcript-meta text-pretty text-(--muted-foreground)">{codeSteps(name)}</p>
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
            <KeyIcon size={14} class="shrink-0" />SSH password or key passphrase for {selected?.sshTarget}
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
          {#if failureAt === "password"}<p role="alert" class="m-0 text-transcript-meta text-(--solus-status-error)">{card.failure?.message}</p>{/if}
          <p class="m-0 text-transcript-meta text-(--muted-foreground)">It goes to the session's host once and is not saved.</p>
        </div>
      {/if}

      {#if card.sshProgress && card.phase === "sending"}
        <p class="m-0 text-transcript-meta text-(--muted-foreground)" role="status">
          {card.sshProgress.message}{#if card.sshProgress.percent !== undefined}&nbsp;· {card.sshProgress.percent}%{/if}
        </p>
      {/if}

      {#if failureAt === "general"}
        <p role="alert" class="m-0 text-transcript-meta text-(--solus-status-error)">{card.failure?.message}</p>
      {/if}

      {#if canEnterCode}
        <button type="button" class="interrupt-link w-fit" disabled={closed || isBusy} onclick={() => card.enterCode()}>Enter a code instead</button>
      {/if}
    {/if}
  </form>
  {#snippet footer()}
    {#if !request.expired}
      <div class="flex items-center justify-end gap-1">
        <Button size="sm" variant="ghost" disabled={closed || isBusy} onclick={() => void card.decline()}>Decline</Button>
        <Button size="sm" type="submit" form="{idBase}-form" disabled={closed || isBusy}>
          {card.failure && card.phase === "choose" ? "Try again" : addLabel()}
        </Button>
      </div>
    {/if}
  {/snippet}
</InterruptCard>
