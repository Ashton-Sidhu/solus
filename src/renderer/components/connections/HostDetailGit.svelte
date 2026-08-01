<script lang="ts">
  /** Everything this host needs before it can clone a repo and push it back:
   *  an account, the two pieces of plumbing that carry its token, and a name
   *  to sign commits with. */
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import GitHostPanel from "../servers/GitHostPanel.svelte";
  import type { HostSetupSession } from "../servers/host-setup.store.svelte";
  import type { GitCommitIdentity } from "../../../shared/types";

  interface Props {
    setup: HostSetupSession;
  }

  let { setup }: Props = $props();
  /** Null until the user types: until then the host's own answer is the truth. */
  let identityDraft = $state<GitCommitIdentity | null>(null);

  const readiness = $derived(setup.readiness);
  const hasToken = $derived(!!readiness?.github?.solusToken);
  const hasGhCli = $derived(!!readiness?.github?.ghCli);
  const identity = $derived(
    identityDraft ?? readiness?.git?.identity ?? { name: "", email: "" },
  );
  const identityChanged = $derived(
    identity.name !== (readiness?.git?.identity?.name ?? "") ||
      identity.email !== (readiness?.git?.identity?.email ?? ""),
  );

  async function saveIdentity() {
    await setup.setGitIdentity({ ...identity });
    // Fall back to whatever the host now reports, rather than to what was typed.
    identityDraft = null;
  }
</script>

<GitHostPanel {setup} />

<SettingsSection label="Token plumbing">
  <SettingsRow
    label="Git credential helper"
    description="Hands the GitHub token to git, so pushes from this host stop asking for a password."
  >
    {#snippet control()}
      {#if readiness?.git?.credentialHelper}
        <span class="text-[0.75rem] text-(--solus-text-tertiary)"
          >Configured</span
        >
      {:else}
        <Button
          variant="outline"
          size="sm"
          disabled={!hasToken || !!setup.runningStep}
          title={hasToken ? undefined : "Connect GitHub first"}
          onclick={() => void setup.installCredentialHelper()}
        >
          {setup.runningStep === "credential-helper" ? "Running…" : "Run"}
        </Button>
      {/if}
    {/snippet}
  </SettingsRow>

  <SettingsRow label="GitHub CLI" description="Authenticate the GitHub CLI">
    {#snippet control()}
      {#if hasGhCli}
        {#if readiness?.github?.ghAuthenticated}
          <span class="text-[0.75rem] text-(--solus-text-tertiary)"
            >Configured</span
          >
        {:else}
          <Button
            variant="outline"
            size="sm"
            disabled={!hasToken || !!setup.runningStep}
            title={hasToken ? undefined : "Connect GitHub first"}
            onclick={() => void setup.authorizeGhCli()}
          >
            {setup.runningStep === "gh-auth" ? "Running…" : "Run"}
          </Button>
        {/if}
      {:else if setup.canInstallGh}
        <Button
          variant="outline"
          size="sm"
          disabled={!!setup.runningStep}
          onclick={() => void setup.installGh()}
        >
          {setup.runningStep === "gh-cli" ? "Installing…" : "Install"}
        </Button>
      {/if}
    {/snippet}
  </SettingsRow>

  {#if setup.stepError?.step === "credential-helper" || setup.stepError?.step === "gh-cli" || setup.stepError?.step === "gh-auth"}
    <div class="border-t border-border px-4 py-3">
      <p
        class="cursor-text select-text text-pretty text-[0.75rem] text-(--solus-status-error)"
      >
        {setup.stepError.message}
      </p>
    </div>
  {/if}

  <SettingsRow
    label="Clone location"
    description={readiness?.projectsRoot ?? "Not reported by this host"}
    comingSoon
  >
    {#snippet control()}
      <Button variant="outline" size="sm">Choose…</Button>
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsSection label="Commit identity">
  <SettingsRow
    label="Author"
    description="What this host signs its commits with. Copied from this Mac when it joined."
  >
    {#snippet body()}
      <div class="flex flex-col gap-2 sm:flex-row">
        <Input
          value={identity.name}
          placeholder="Name"
          aria-label="Commit author name"
          oninput={(event) =>
            (identityDraft = { ...identity, name: event.currentTarget.value })}
        />
        <Input
          value={identity.email}
          placeholder="you@example.com"
          aria-label="Commit author email"
          oninput={(event) =>
            (identityDraft = { ...identity, email: event.currentTarget.value })}
        />
        <Button
          class="shrink-0"
          disabled={!identityChanged ||
            !identity.name.trim() ||
            !identity.email.trim() ||
            setup.runningStep === "identity"}
          onclick={() => void saveIdentity()}
        >
          {setup.runningStep === "identity" ? "Saving…" : "Save"}
        </Button>
      </div>
      {#if setup.stepError?.step === "identity"}
        <p
          class="mt-2 cursor-text select-text text-pretty text-[0.75rem] text-(--solus-status-error)"
        >
          {setup.stepError.message}
        </p>
      {/if}
    {/snippet}
  </SettingsRow>
</SettingsSection>
