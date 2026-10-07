<script lang="ts">
  /**
   * One coding agent, install and sign-in in a single action, expanding into
   * whatever the CLI asked for. Shared by the pointer flow's agents stage and
   * the touch flow's host stage so both drive the same setup session and can
   * never disagree about where an agent stands.
   */
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import OnboardingRow from "./OnboardingRow.svelte";
  import ProviderMark from "../ui/ProviderMark.svelte";
  import SignInSteps from "../seats/SignInSteps.svelte";
  import type { ProviderRow } from "../servers/lib/host-onboarding";
  import type { SetupAgent } from "@solus/contracts/types";

  interface Props {
    agent: SetupAgent;
    row: ProviderRow;
    delay?: number;
  }

  let { agent, row, delay = 0 }: Props = $props();

  const setup = $derived(store.setup);
  const verification = $derived(setup.verificationFor(agent));
  const failure = $derived(
    setup.stepError?.provider === agent ? setup.stepError.message : null,
  );
</script>

<OnboardingRow
  name={row.label}
  detail={row.detail}
  {delay}
  state={row.state}
  actionLabel={row.actionLabel}
  onaction={row.run}
  expanded={!!verification || !!failure}
>
  {#snippet mark()}
    <ProviderMark mark={agent} size={24} transparent />
  {/snippet}
  {#snippet expansion()}
    {#if verification}
      <!-- The same steps Settings and the conversation show: the code some
           CLIs want entered on their page, or the field for a code the page
           hands back. -->
      <SignInSteps
        label={row.label}
        {verification}
        browserOpened={store.surface === "pointer"}
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
