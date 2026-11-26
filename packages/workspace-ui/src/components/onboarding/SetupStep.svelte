<script lang="ts">
  /**
   * Desktop step 1, where the setup lives (docs/plans/one-page-onboarding.md
   * decision 3). The account is preselected; while the browser sign-in runs the
   * step offers the page again and the way out to This Mac only.
   */
  import { tick } from "svelte";
  import { ArrowUpRight as ExternalIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import ChoiceRow from "./ChoiceRow.svelte";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import { radioArrowKey } from "./lib/radio-keys";
  import type { SetupChoice } from "./lib/onboarding-model";

  let { machineNoun }: { machineNoun: string } = $props();

  const CHOICES: SetupChoice[] = ["account", "local"];
  let group = $state<HTMLDivElement | null>(null);

  async function onGroupKeydown(event: KeyboardEvent) {
    const next = radioArrowKey(event.key, CHOICES, store.choice);
    if (!next) return;
    event.preventDefault();
    store.chooseSetup(next);
    await tick();
    group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }
</script>

{#if store.signingIn}
  <div class="flex flex-wrap items-center gap-3.5 pt-1.5">
    <Button variant="outline" size="sm" class="h-7.5 gap-1 rounded-md px-3 text-[13px] font-medium" onclick={() => store.reopenSignInPage()}>
      Open the page again <ExternalIcon size={13} />
    </Button>
    <button
      type="button"
      class="rounded-sm text-[13px] leading-4.5 text-(--solus-text-tertiary) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-ring"
      onclick={() => store.useThisMacOnly()}
    >
      Use This {machineNoun} only instead
    </button>
  </div>
{:else}
  <div bind:this={group} role="radiogroup" aria-label="Where your setup lives" tabindex="-1" onkeydown={onGroupKeydown}>
    <ChoiceRow
      title="Your Solus Cloud account"
      detail="Saved to your account and synced to every machine, the web and your phone. Cloud hosts can use your agent sign-ins."
      isChosen={store.choice === "account"}
      onchoose={() => store.chooseSetup("account")}
    />
    <ChoiceRow
      title="This {machineNoun} only"
      detail="Nothing leaves this {machineNoun} and no account is needed. You can sign in later and move it to an account."
      isChosen={store.choice === "local"}
      onchoose={() => store.chooseSetup("local")}
    />
  </div>
  {#if store.signInError}
    <p class="m-0 pt-1 text-[13px] leading-4.5 text-(--solus-status-error)" role="alert">{store.signInError}</p>
  {/if}
{/if}
