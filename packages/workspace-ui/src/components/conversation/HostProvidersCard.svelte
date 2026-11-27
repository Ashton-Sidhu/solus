<script lang="ts">
  /** The Sign in card of `add_host` (docs/host-provider-sign-in.md). The
   *  machine is added, but the provider that the work needs is not signed in
   *  there. Sign in opens the host's AI providers tab and starts the sign-in;
   *  the session host closes the card when the new host reports it, and the
   *  conversation comes back. Not now is the one answer this card sends. */
  import { hostProvidersSkipAnswers, type HostProvidersAsk } from "@solus/contracts/add-machine";
  import type { QuestionRequest, SetupAgent } from "@solus/contracts/types";
  import { getClientShellContext, getWorkspaceContext, serversStore } from "../../contexts";
  import { canDriveSession } from "../../contexts/sharing/resource-roles";
  import { runHost } from "../../contexts/workspace/run-location";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { sessionTitle } from "../../lib/sessionUtils";
  import { connectionsNav, type HostPageTab } from "../connections/connections-nav.svelte";
  import { signInReturns } from "../connections/sign-in-return.svelte";
  import { hostSetupStore } from "../servers/host-setup.store.svelte";
  import { codingProviderRows } from "../servers/lib/host-onboarding";
  import ProviderChoiceCard from "../servers/ProviderChoiceCard.svelte";
  import { Button } from "../ui/button";
  import InterruptCard from "./InterruptCard.svelte";
  import { hostProvidersTitle, providerLabel, serverOfInstallation } from "./lib/host-providers-card";

  interface Props {
    tabId: string;
    request: QuestionRequest;
    ask: HostProvidersAsk;
    /** Answers another session's card. Unset, the answer goes to this tab's session. */
    answer?: (questionId: string, answers: Record<string, string>) => Promise<boolean>;
  }
  let { tabId, request, ask, answer }: Props = $props();

  const session = getWorkspaceContext();
  const shell = getClientShellContext();
  const sess = $derived(session.sessionFor(tabId));
  const canDrive = $derived(canDriveSession(runHost(sess?.run), sess?.id, "drive.approve"));
  // The host list follows the pairing a moment after the card shows; until then this device cannot reach the host.
  const server = $derived(serverOfInstallation(serversStore.servers, ask.installationId));
  const serverId = $derived(server?.id ?? null);
  const isReachable = $derived(server?.readiness === "ready");
  const setup = $derived(serverId ? hostSetupStore.sessionFor(serverId) : null);
  let isSending = $state(false);
  let didFail = $state(false);
  const closed = $derived(!!request.expired || !canDrive || isSending);

  // Read the new host's providers once this device reaches it: the rows say where each one stands.
  $effect(() => {
    if (serverId && isReachable && !hostSetupStore.hasProbed(serverId)) void hostSetupStore.probeHost(serverId);
  });

  const rows = $derived(setup
    ? codingProviderRows({
        readiness: setup.readiness,
        stages: setup.providerStages,
        add: (provider, opts) => signIn(provider, opts),
      }).map((row) => (closed ? { ...row, disabled: true } : row))
    : []);

  /** Opens the host's page, and brings the conversation back when this card closes while the person is still there. */
  function openHostPage(targetServerId: string, tab: HostPageTab) {
    signInReturns.begin(
      {
        tabId,
        serverId: targetServerId,
        questionId: request.questionId,
        conversationTitle: sess ? sessionTitle(sess) : "The conversation",
        providerLabel: providerLabel(ask.provider),
      },
      {
        isOnHostPage: () => session.router.at("settings") && connectionsNav.hostId === targetServerId,
        showConversation: () => {
          if (!session.sessionFor(tabId)) return;
          session.selectTab(tabId);
          requestInputFocus({ tabId });
        },
      },
    );
    shell.openResource({ kind: "connections", serverId: targetServerId, tab });
  }

  function signIn(provider: SetupAgent, opts?: { force?: boolean }) {
    if (!serverId || !setup) return;
    openHostPage(serverId, "providers");
    void setup.addProvider(provider, opts);
  }

  async function skip() {
    isSending = true;
    didFail = false;
    const answers = hostProvidersSkipAnswers();
    const answered = answer
      ? await answer(request.questionId, answers)
      : await session.controls.respondQuestion(tabId, request.questionId, answers);
    isSending = false;
    if (!answered) {
      didFail = true;
      return;
    }
    signInReturns.cardClosed(request.questionId);
    requestInputFocus({ tabId });
  }
</script>

<InterruptCard type="question" title="Sign in" testId="host-providers-card">
  <div class="flex min-w-0 flex-col gap-3">
    <div class="flex min-w-0 flex-col gap-1">
      <p class="interrupt-title m-0 wrap-anywhere">{hostProvidersTitle(ask)}</p>
      <p class="m-0 text-transcript-meta text-pretty text-(--muted-foreground)">{ask.reason} The account stays on {ask.hostName}.</p>
    </div>

    {#if request.expired}
      <p class="m-0 text-transcript-meta text-(--muted-foreground)">This request is closed.</p>
    {:else if !isReachable}
      <p class="m-0 text-transcript-meta text-pretty text-(--muted-foreground)">Connecting to {ask.hostName}…</p>
    {:else}
      <ProviderChoiceCard {rows} flush label="AI providers on {ask.hostName}" />
    {/if}

    {#if didFail}<p role="alert" class="m-0 text-transcript-meta text-(--solus-status-error)">The answer did not reach the agent. Try again.</p>{/if}
  </div>
  {#snippet footer()}
    {#if !request.expired}
      <div class="flex min-w-0 items-center justify-end gap-1">
        {#if !canDrive}
          <span class="text-transcript-meta text-(--muted-foreground)">Waiting for an editor</span>
        {:else}
          <Button size="sm" variant="ghost" disabled={closed} onclick={() => void skip()}>Not now</Button>
          <Button size="sm" variant="outline" disabled={!serverId} onclick={() => serverId && openHostPage(serverId, "overview")}>Manage host</Button>
        {/if}
      </div>
    {/if}
  {/snippet}
</InterruptCard>
