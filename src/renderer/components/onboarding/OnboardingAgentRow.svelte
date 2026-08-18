<script lang="ts">
  /**
   * One coding agent, install and sign-in in a single action, expanding into
   * whatever the CLI asked for. Shared by the pointer flow's agents stage and
   * the touch flow's host stage so both drive the same setup session and can
   * never disagree about where an agent stands.
   */
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import { AGENT_PRESENTATION } from "./lib/onboarding-model";
  import OnboardingRow from "./OnboardingRow.svelte";
  import DevicePrompt from "../servers/DevicePrompt.svelte";
  import type { ProviderRow } from "../servers/lib/host-onboarding";
  import type { SetupAgent } from "../../../shared/types";

  interface Props {
    agent: SetupAgent;
    row: ProviderRow;
    delay?: number;
  }

  let { agent, row, delay = 0 }: Props = $props();

  const setup = $derived(store.setup);
  const verification = $derived(setup.verifications[agent]);
  const failure = $derived(
    setup.stepError?.provider === agent ? setup.stepError.message : null,
  );

  /**
   * A CLI either shows a code to enter on its sign-in page, or wants one pasted
   * back. On touch the browser is never opened for the user: the CLI runs on
   * the host, so the only way through is the prompt's own Open action. Saying
   * "it opened your browser" there sends a phone user looking for a window that
   * was never going to appear.
   */
  const why = $derived.by(() => {
    const openedForYou = store.surface === "pointer";
    if (verification?.requiresCodeInput) {
      return openedForYou
        ? `${row.label} opened your browser. Finish signing in, then paste the returned code here.`
        : `Open the ${row.label} sign-in page below, finish signing in, then paste the returned code here.`;
    }
    return openedForYou
      ? `Enter this code on the ${row.label} sign-in page in your browser.`
      : `Open the ${row.label} sign-in page below and enter this code.`;
  });
</script>

<OnboardingRow
  name={row.label}
  detail={row.detail}
  {delay}
  tint={AGENT_PRESENTATION[agent].tint}
  abbr={AGENT_PRESENTATION[agent].abbr}
  state={row.state}
  statusText={row.state === "busy" ? row.detail : undefined}
  actionLabel={row.actionLabel}
  onaction={row.run}
  expanded={!!verification || !!failure}
>
  {#snippet expansion()}
    {#if verification}
      <!-- The same prompt Settings shows: the one-time code some CLIs want
           entered on the page, or the field for a code the page hands back. -->
      <DevicePrompt
        url={verification.url}
        code={verification.code}
        label={row.label}
        requiresCodeInput={verification.requiresCodeInput}
        {why}
        onsubmit={(code) => setup.submitAgentSignInCode(agent, code)}
        oncancel={() => void setup.cancelAgentSignIn(agent)}
      />
    {:else if failure}
      <p
        class="cursor-text select-text text-pretty text-xs leading-relaxed text-(--solus-status-error)"
        role="alert"
      >
        {failure}
      </p>
    {/if}
  {/snippet}
</OnboardingRow>
