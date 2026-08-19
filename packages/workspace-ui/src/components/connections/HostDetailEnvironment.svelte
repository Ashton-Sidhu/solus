<script lang="ts">
  /** What the host actually has on it, probed rather than assumed — and the one
   *  gap that stops it cloning anything, repaired here. */
  import { ArrowsClockwiseIcon } from "phosphor-svelte";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import type { HostSetupSession } from "../servers/host-setup.store.svelte";

  interface Props {
    setup: HostSetupSession;
  }

  let { setup }: Props = $props();

  const readiness = $derived(setup.readiness);
  const git = $derived(readiness?.git);
  const sshKeys = $derived(readiness?.ssh?.publicKeys ?? []);
</script>

<SettingsSection label="Detected on this host">
  {#snippet action()}
    <Button
      variant="ghost"
      size="sm"
      class="-my-1 text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
      disabled={setup.readinessLoading}
      onclick={() => void setup.refreshReadiness()}
    >
      <ArrowsClockwiseIcon
        size={13}
        class={setup.readinessLoading ? "animate-spin" : ""}
      />
      Re-scan
    </Button>
  {/snippet}

  <SettingsRow
    label="Platform"
    description={readiness?.platform ?? "Not reported by this host"}
  />

  <SettingsRow
    label="Git"
    description={git?.installed
      ? "Installed"
      : (readiness?.installGit?.display ??
        "Not installed — this host cannot clone anything")}
    body={setup.stepError?.step === "git" ? gitError : undefined}
  >
    {#snippet control()}
      {#if readiness && !git?.installed}
        <Button
          variant="outline"
          size="sm"
          disabled={!!setup.runningStep}
          onclick={() => void setup.installGit()}
        >
          {setup.runningStep === "git" ? "Installing…" : "Install git"}
        </Button>
      {/if}
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Home folder"
    description={readiness?.home ?? "Not reported by this host"}
  />

  <SettingsRow
    label="SSH keys"
    description={sshKeys.length > 0 ? sshKeys.join(", ") : "None found in ~/.ssh"}
  />

  <SettingsRow
    label="Projects folder"
    description={readiness?.projectsRoot ?? "Not reported by this host"}
  />
</SettingsSection>

<SettingsSection label="How sessions run here">
  <SettingsRow
    label="Worktree per session"
    description="Give each session its own checkout instead of sharing the repo."
    comingSoon
  >
    {#snippet control()}
      <Switch checked={false} size="default" aria-label="Worktree per session" />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Environment variables"
    description="Values every session on this host starts with."
    comingSoon
  >
    {#snippet control()}
      <Button variant="outline" size="sm">Edit</Button>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Setup script"
    description="Run before the first prompt of a session on this host."
    comingSoon
  >
    {#snippet control()}
      <Button variant="outline" size="sm">Edit</Button>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Login shell"
    description="Which shell a session's commands run through."
    comingSoon
  >
    {#snippet control()}
      <Button variant="outline" size="sm">Default</Button>
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#snippet gitError()}
  <p class="text-pretty text-xs text-(--solus-status-error)">
    {setup.stepError?.message}
  </p>
{/snippet}
