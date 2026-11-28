<script lang="ts">
  /**
   * A Claude or Codex sign-in as two plain steps on a rail: open the provider's
   * page and sign in, then bring the code across. The current step has a ring,
   * so a person who is not a developer always sees where they are.
   * The conversation card, Settings, host setup, and onboarding all mount it,
   * so the sign-in reads the same everywhere.
   */
  import { localApi } from "@solus/client-core/local-api";
  import type { SeatConnectStartResult } from "@solus/contracts/seats";
  import { ExternalLink as ExternalLinkIcon, LoaderCircle as SpinnerIcon } from "@lucide/svelte";
  import CopyButton from "../ui/CopyButton.svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { signInCodeFlowOf, signInSteps, type SignInCodeFlow } from "@solus/client-core/sign-in-steps";
  import StepRail from "../steps/StepRail.svelte";

  interface Props {
    /** The provider's name: `Claude` or `Codex`. */
    label: string;
    /** Which way the code goes before the host has answered; only the first step reads it. */
    codeFlow?: SignInCodeFlow;
    /** Where to sign in, once the host started the login. Absent before the first step. */
    verification?: SeatConnectStartResult;
    /**
     * The host's start already opened the page in this device's browser. On
     * touch it never does, so the first step waits for the person's own tap
     * rather than telling them to look for a window that never appeared.
     */
    browserOpened?: boolean;
    /** The host is starting the login. */
    starting?: boolean;
    /** Why the last attempt ended without a sign-in. */
    error?: string;
    /** The first step's action. Without it, the steps show only once a login is waiting. */
    onstart?: () => void;
    startLabel?: string;
    onsubmit: (code: string) => Promise<void>;
    oncancel: () => void;
    /** Closes the prompt without starting, beside the first step's action. */
    ondismiss?: () => void;
    autofocus?: boolean;
  }

  let {
    label,
    codeFlow = "paste",
    verification,
    browserOpened = true,
    starting = false,
    error,
    onstart,
    startLabel,
    onsubmit,
    oncancel,
    ondismiss,
    autofocus = false,
  }: Props = $props();

  const flow = $derived<SignInCodeFlow>(verification ? signInCodeFlowOf(verification) : codeFlow);
  let code = $state("");
  let submitting = $state(false);
  /** The login a code went to. A new login starts with the field open again. */
  let sentTo = $state<SeatConnectStartResult | null>(null);
  const sent = $derived(!!verification && sentTo === verification);
  /** The login whose page the person opened from here. */
  let openedFor = $state<SeatConnectStartResult | null>(null);
  const pageOpen = $derived(!!verification && (browserOpened || openedFor === verification));
  const steps = $derived(signInSteps(label, flow, !pageOpen ? "start" : submitting || sent ? "checking" : "code"));

  function openPage() {
    if (!verification) return;
    openedFor = verification;
    void localApi.openExternal(verification.verificationUrl);
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!verification || !code.trim() || submitting) return;
    submitting = true;
    try {
      await onsubmit(code.trim());
      sentTo = verification;
      code = "";
    } catch {
      // Reported where the login's other failures are; the field stays to try again.
    } finally {
      submitting = false;
    }
  }
</script>

<div class="flex flex-col gap-2.5 text-activity-label">
  <StepRail {steps}>
    {#snippet detail(step)}
      {#if step.state === "current" && verification && flow === "enter" && verification.userCode}
        <div class="mt-2 flex items-center gap-2">
          <code class="font-sans text-base font-semibold tracking-[0.2em] tabular-nums text-(--solus-text-primary)">{verification.userCode}</code>
          <CopyButton text={verification.userCode} title="Copy the code" />
        </div>
      {:else if step.state === "current" && verification && flow !== "enter" && !sent}
        <form class="mt-2 flex items-center gap-2" onsubmit={submit}>
          <Input
            bind:value={code}
            class="h-8 min-w-0 flex-1 bg-(--solus-tx-card-bg)"
            placeholder={flow === "paste-address" ? "http://127.0.0.1:…" : "Paste your code here"}
            autocomplete={flow === "paste-address" ? "off" : "one-time-code"}
            aria-label="{label} sign-in code"
            dictation={false}
            disabled={submitting}
            {autofocus}
          />
          <!-- Neutral until there is a code: a disabled accent button reads
               as a washed-out block, not as the next step. -->
          <Button
            type="submit"
            class="pointer-coarse:min-h-11"
            size="default"
            variant={code.trim() ? "default" : "secondary"}
            disabled={!code.trim() || submitting}
          >
            {#if submitting}<SpinnerIcon class="animate-spin" />Checking{:else}Continue{/if}
          </Button>
        </form>
      {/if}
      {#if step.state === "current" && verification && (sent || flow === "enter")}
        <span class="mt-2 flex items-center gap-2 text-xs text-(--muted-foreground)" role="status">
          <SpinnerIcon size={12} class="shrink-0 animate-spin" />
          {sent ? "Finishing your sign-in…" : `Waiting for ${label}…`}
        </span>
      {/if}
    {/snippet}
  </StepRail>

  {#if error}
    <div class="flex flex-col gap-0.5 text-pretty text-xs leading-normal" role="alert">
      <p class="m-0 text-destructive">{error}</p>
      <p class="m-0 text-(--muted-foreground)">A code works once and expires after a few minutes. Start again to get a fresh one.</p>
    </div>
  {/if}

  {#if verification}
    <p class="m-0 flex items-center gap-1 text-pretty text-xs text-(--muted-foreground)">
      On a different computer or phone? Copy the sign-in link and open it there.
      <CopyButton text={verification.verificationUrl} title="Copy the sign-in link" iconOnly />
    </p>
  {/if}

  <div class="flex items-center gap-2">
    {#if verification && !pageOpen}
      <Button size="sm" class="pointer-coarse:min-h-11" onclick={openPage}>
        Open {label}
        <ExternalLinkIcon data-icon="inline-end" />
      </Button>
      <span class="flex-1"></span>
      <Button size="sm" variant="ghost" class="-mr-2.5 text-muted-foreground pointer-coarse:min-h-11" onclick={oncancel}>Cancel</Button>
    {:else if verification}
      <Button size="sm" variant="ghost" class="-ml-2.5 text-muted-foreground pointer-coarse:min-h-11" onclick={openPage}>
        Open {label} again
        <ExternalLinkIcon data-icon="inline-end" />
      </Button>
      <span class="flex-1"></span>
      <Button size="sm" variant="ghost" class="-mr-2.5 text-muted-foreground pointer-coarse:min-h-11" onclick={oncancel}>Cancel</Button>
    {:else if onstart}
      <Button size="sm" class="pointer-coarse:min-h-11" disabled={starting} onclick={onstart}>
        {starting ? "Opening…" : (startLabel ?? `Open ${label}`)}
        {#if !starting}<ExternalLinkIcon data-icon="inline-end" />{/if}
      </Button>
      <span class="flex-1"></span>
      {#if ondismiss}
        <Button size="sm" variant="ghost" class="-mr-2.5 text-muted-foreground pointer-coarse:min-h-11" onclick={ondismiss}>Not now</Button>
      {/if}
    {/if}
  </div>
</div>
