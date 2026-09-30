<script lang="ts">
  /**
   * GitHub for a Solus Cloud account (docs/plans/cloud-onboarding.md §3.3).
   * In the cloud, GitHub is connected to the account, not to one machine: the
   * cloud host clones with it and the workspace service reads pull requests
   * with it. The connection is made on the account's Connections page in a new
   * tab, and this stage reads the account again when the person comes back.
   *
   * Skip moves to the shared start choice. A new project, a host folder, and
   * a chat do not need GitHub.
   */
  import Icon from "@iconify/svelte";
  import { cloudAccount } from "@solus/client-core/cloud-account";
  import { localApi } from "@solus/client-core/local-api";
  import { onMount } from "svelte";
  import { cloudOnboardingStore as cloud } from "./cloud-onboarding.store.svelte";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import OnboardingRow from "./OnboardingRow.svelte";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";

  interface Props {
    onskip: () => void;
  }

  let { onskip }: Props = $props();

  const github = $derived(cloud.account?.github ?? null);
  const connected = $derived(github !== null);
  let waiting = $state(false);

  onMount(() => {
    void cloud.refreshGithub();
    // The connection is made in another tab; coming back is the signal to ask again.
    const onFocus = () => void cloud.refreshGithub();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  });

  function connect() {
    const url = cloudAccount()?.connectionsUrl;
    if (!url) return;
    waiting = true;
    void localApi.openExternal(url);
  }
</script>

<div class="flex min-h-full flex-col items-center justify-center px-6 py-10 sm:px-10 sm:py-12">
  <h1 class="onboarding-title m-0 shrink-0 text-center text-2xl font-medium leading-[1.12]">
    {connected ? "GitHub is connected" : "Connect GitHub"}
  </h1>
  <p
    class="onboarding-title mt-3 max-w-[40ch] shrink-0 text-center text-sm leading-[1.6] text-muted-foreground"
    style="animation-delay: 0.06s"
  >
    Solus Cloud uses it to clone your repositories and show pull requests. It belongs to your
    account, so every machine you use gets it.
  </p>

  <div class="mt-8 flex w-full max-w-[28.25rem] shrink-0 flex-col gap-2.5 sm:mt-10">
    <OnboardingRow
      name="GitHub"
      detail={connected
        ? github?.login
          ? `Connected as @${github.login}`
          : "Connected"
        : waiting
          ? "Finish in the new tab"
          : "Opens Connections in a new tab"}
      tint="var(--chart-5)"
      state={connected ? "done" : "available"}
      actionLabel={waiting ? "Open again" : "Connect"}
      onaction={connect}
    >
      {#snippet mark()}
        <Icon icon="logos:github-icon" width={18} height={18} />
      {/snippet}
    </OnboardingRow>
  </div>

  <OnboardingStageActions
    continueLabel="Continue"
    continueEnabled={connected}
    oncontinue={() => store.advance()}
    onback={() => store.back()}
    {onskip}
  />
</div>
