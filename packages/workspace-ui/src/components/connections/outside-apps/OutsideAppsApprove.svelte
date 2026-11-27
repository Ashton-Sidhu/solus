<script lang="ts">
  /** "Approve a sign-in" (plans/035 §0.5): an app's sign-in page waits with a
   *  check code. The person types that code (or pastes the page's
   *  `solus://approve-app` link), reads what the app asks for, and approves or
   *  denies it as themself. A link opens this view with the sign-in shown.
   *  Settings › Sharing & access shows it from its header action, the palette,
   *  and a sign-in link. */
  import { onMount, tick } from "svelte";
  import { CircleCheck as ApprovedIcon, CircleX as DeniedIcon, TriangleAlert as WarningIcon } from "@lucide/svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { liveActivityClock } from "../../../lib/shared-clock";
  import { Button } from "../../ui/button";
  import { Input } from "../../ui/input";
  import { appSignInAccess, appSignInDoneText, appSignInPlaceText, appSignInTimeLeft } from "../lib/app-sign-in";
  import { serversStore } from "../../../contexts";
  import { serverIdForAppSignIn } from "../lib/app-sign-in";
  import { AppSignInApproval } from "./app-sign-in-approval.svelte";

  interface Props {
    serverId: string;
    hostName: string;
    /** The sign-in a link named; null shows the code field. */
    signInRequestId: string | null;
    /** Opens this view on another host, for a pasted link to a sign-in there. */
    onOtherHost: (serverId: string, requestId: string) => void;
  }

  let { serverId, hostName, signInRequestId, onOtherHost }: Props = $props();

  const approval = new AppSignInApproval({
    // svelte-ignore state_referenced_locally
    serverId,
    // svelte-ignore state_referenced_locally
    api: serverConnections.apiFor(serverId),
    serverIdFor: (hostId) => serverIdForAppSignIn(hostId, serversStore.servers),
    // svelte-ignore state_referenced_locally
    onOtherHost,
  });

  let codeEl = $state<HTMLInputElement | null>(null);
  let decisionEl = $state<HTMLDivElement | null>(null);
  let now = $state(Date.now());

  const phase = $derived(approval.phase);
  const request = $derived(phase.kind === "shown" || phase.kind === "deciding" || phase.kind === "done" ? phase.request : null);
  const timeLeft = $derived(request ? appSignInTimeLeft(request.expiresAt, now) : null);
  const accessLevel = $derived(request ? appSignInAccess(request) : null);

  $effect(() => {
    if (phase.kind !== "shown" && phase.kind !== "deciding") return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  onMount(() => {
    if (signInRequestId) void approval.openLink({ hostId: serverId, requestId: signInRequestId }).then(focusPhase);
    else codeEl?.focus();
  });

  /** Keeps the keyboard on the view: the code field to type, else the first decision button. */
  async function focusPhase() {
    await tick();
    if (approval.phase.kind === "enter") codeEl?.focus();
    else decisionEl?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    await approval.submitCode();
    await focusPhase();
  }

  async function decide(decision: "approve" | "deny") {
    await approval.decide(decision);
    await focusPhase();
  }

  function another() {
    approval.reset();
    void focusPhase();
  }
</script>

<section class="flex flex-col gap-4" aria-labelledby="outside-apps-approve-title">
  <div class="flex flex-col gap-1">
    <h3 id="outside-apps-approve-title" class="text-workspace-chrome font-medium">Approve a sign-in</h3>
    <p class="text-chrome-dense text-(--solus-text-secondary)">
      When an app's sign-in page for {hostName} shows a code, type it here. The app then acts as you.
    </p>
  </div>

  {#if phase.kind === "enter" || phase.kind === "reading"}
    <form class="flex flex-col gap-2" onsubmit={submit}>
      <label for="outside-apps-approve-code" class="text-chrome-dense text-(--solus-text-secondary)">Code on the sign-in page</label>
      <div class="flex items-center gap-2">
        <Input
          id="outside-apps-approve-code"
          bind:ref={codeEl}
          bind:value={approval.code}
          dictation={false}
          autocomplete="off"
          autocapitalize="characters"
          spellcheck={false}
          placeholder="XXXX-XXXX"
          aria-invalid={approval.error ? true : undefined}
          aria-describedby={approval.error ? "outside-apps-approve-error" : undefined}
          disabled={phase.kind === "reading"}
          class="tracking-wider"
        />
        <Button type="submit" size="sm" class="shrink-0" disabled={phase.kind === "reading" || approval.code.trim() === ""}>
          {phase.kind === "reading" ? "Reading…" : "Continue"}
        </Button>
      </div>
      <p class="text-chrome-dense text-(--solus-text-tertiary)">You can also paste the page's solus://approve-app link.</p>
    </form>
  {:else if request && accessLevel && (phase.kind === "shown" || phase.kind === "deciding")}
    <div class="flex flex-col gap-3 rounded-lg border border-border px-4 py-3" aria-live="polite">
      <div class="flex flex-col gap-0.5">
        <span class="text-workspace-chrome font-medium text-(--solus-text-primary)">{request.appName}</span>
        <span class="text-chrome-dense text-(--solus-text-secondary)">{appSignInPlaceText(request)}</span>
      </div>
      <div class="flex flex-col gap-0.5">
        <span class="text-workspace-chrome text-(--solus-text-primary)">{accessLevel.label} access</span>
        <span class="text-chrome-dense text-(--solus-text-secondary)">{accessLevel.effect}</span>
      </div>
      <span class="text-chrome-dense tabular-nums text-(--solus-text-tertiary)">{timeLeft ?? "This sign-in expired. Start the sign-in in the app again."}</span>
    </div>
    <p class="flex items-start gap-2 text-chrome-dense text-(--solus-text-secondary)">
      <WarningIcon size={16} class="mt-px shrink-0 text-(--warning)" />
      Only approve a sign-in you just started.
    </p>
    <div bind:this={decisionEl} class="flex items-center justify-end gap-2">
      <Button variant="ghost" size="sm" class="bg-muted" disabled={phase.kind === "deciding"} onclick={() => void decide("deny")}>
        {phase.kind === "deciding" && phase.decision === "deny" ? "Denying…" : "Deny"}
      </Button>
      <Button size="sm" disabled={phase.kind === "deciding" || timeLeft === null} onclick={() => void decide("approve")}>
        {phase.kind === "deciding" && phase.decision === "approve" ? "Approving…" : "Approve"}
      </Button>
    </div>
  {:else if request && phase.kind === "done"}
    {@const DoneIcon = phase.decision === "approve" ? ApprovedIcon : DeniedIcon}
    <div class="flex items-start gap-2 rounded-lg border border-border px-4 py-3" role="status">
      <DoneIcon size={16} class={["mt-px shrink-0", phase.decision === "approve" ? "text-(--solus-status-complete)" : "text-(--solus-text-tertiary)"]} />
      <span class="text-workspace-chrome text-(--solus-text-primary)">{appSignInDoneText(request.appName, phase.decision)}</span>
    </div>
    <div bind:this={decisionEl}>
      <Button variant="ghost" size="sm" class="bg-muted" onclick={another}>Approve another sign-in</Button>
    </div>
  {/if}

  {#if approval.error}
    <p id="outside-apps-approve-error" role="alert" class="text-chrome-dense text-(--solus-status-error)">{approval.error}</p>
  {/if}
</section>
