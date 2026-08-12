<script lang="ts">
  import { slide } from "svelte/transition";
  import {
    CopyIcon,
    GitBranchIcon,
    GithubLogoIcon,
    SparkleIcon,
    UserIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { toasts } from "../../lib/toasts";
  import GitHostPanel from "./GitHostPanel.svelte";
  import ProviderPanel from "./ProviderPanel.svelte";
  import type { OpenProjectStore } from "./open-project.store.svelte";

  interface Props {
    store: OpenProjectStore;
    /** This client's own identity, offered as the prefill for a bare host. */
    localIdentity?: { name: string; email: string } | null;
  }

  let { store, localIdentity = null }: Props = $props();

  // Only what is actually missing gets a row. A host that is ready shows
  // nothing at all — the old always-on rail of four green pills was noise on
  // every open, and the one red pill that mattered had to compete with it.
  type NoteId = "git" | "github" | "agent" | "identity";
  let openNote = $state<NoteId | null>(null);
  let identityName = $state("");
  let identityEmail = $state("");

  const setup = $derived(store.setup);
  const readiness = $derived(setup?.readiness ?? null);
  // Guarded per field: an older host answers with an older readiness shape.
  const gitMissing = $derived(!!readiness && !readiness.git?.installed);
  const githubMissing = $derived(!!readiness && !readiness.github?.solusToken);
  const agentMissing = $derived(
    !!store.capabilities &&
      !store.capabilities.agents?.claude &&
      !store.capabilities.agents?.codex,
  );
  const identityMissing = $derived(!!readiness && !readiness.git?.identity);
  const installGit = $derived(readiness?.installGit ?? null);

  /**
   * A missing GitHub sign-in only ever blocks private GitHub repositories, so
   * it is raised against a github.com URL and nothing else. The GitHub step
   * owns its own connect panel; every other host is none of GitHub's business.
   */
  const showGithub = $derived(
    githubMissing &&
      store.source === "clone" &&
      /(^|@|\/\/)github\.com[/:]/i.test(store.cloneUrl ?? ""),
  );

  function toggle(id: NoteId) {
    openNote = openNote === id ? null : id;
    if (openNote !== "identity") return;
    identityName = readiness?.git?.identity?.name ?? localIdentity?.name ?? "";
    identityEmail = readiness?.git?.identity?.email ?? localIdentity?.email ?? "";
  }

  async function copy(text: string) {
    await navigator.clipboard?.writeText(text).catch(() => {});
    toasts.success("Command copied");
  }
</script>

{#snippet note(id: NoteId, label: string, icon: typeof GitBranchIcon, blocking: boolean)}
  {@const Icon = icon}
  <button
    type="button"
    aria-expanded={openNote === id}
    class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none
      [transition:background-color_var(--duration-quick)_var(--ease-premium)] motion-reduce:transition-none
      focus-visible:ring-2 focus-visible:ring-(--solus-accent)
      {blocking
      ? 'text-(--solus-status-error) hover:bg-(--solus-status-error)/8'
      : 'text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)'}"
    onclick={() => toggle(id)}
  >
    <Icon size={13} weight="fill" class="shrink-0" />
    <span class="min-w-0 flex-1 truncate text-xs">{label}</span>
    <span class="shrink-0 text-xs font-medium text-(--solus-accent)">
      {openNote === id ? "Hide" : "Fix"}
    </span>
  </button>
{/snippet}

{#if gitMissing || showGithub || agentMissing || identityMissing || setup?.readinessError}
  <div class="flex flex-col gap-0.5" transition:slide={{ duration: 160 }}>
    {#if setup?.readinessError}
      <p
        class="flex items-center gap-2 px-2 py-1.5 text-xs text-(--solus-status-error)"
      >
        <WarningCircleIcon size={13} weight="fill" class="shrink-0" />
        <span class="min-w-0 flex-1 truncate">{setup.readinessError}</span>
      </p>
    {/if}

    {#if gitMissing}
      {@render note("git", `git isn’t installed on ${store.hostLabel || "this host"}`, GitBranchIcon, true)}
    {/if}
    {#if showGithub}
      {@render note("github", "This host isn’t signed in to GitHub", GithubLogoIcon, false)}
    {/if}
    {#if agentMissing}
      {@render note("agent", "No agent CLI here — sessions can’t run yet", SparkleIcon, false)}
    {/if}
    {#if identityMissing}
      {@render note("identity", "No commit identity on this host", UserIcon, false)}
    {/if}

    {#if openNote}
      <div
        class="mt-1 rounded-2xl border border-(--solus-container-border) bg-(--solus-surface-hover)/60 p-3"
        transition:slide={{ duration: 160 }}
      >
        {#if openNote === "git"}
          {#if installGit?.autoRunnable}
            <p class="text-pretty text-xs leading-relaxed font-secondary text-(--solus-text-secondary)">
              Solus can install git on {store.hostLabel || "this host"} by running
              <code class="font-mono text-xs text-(--solus-text-primary)">{installGit.display}</code>.
            </p>
            <Button
              class="mt-2"
              disabled={!setup || !!setup.runningStep}
              onclick={() => void setup?.installGit()}
            >
              {setup?.runningStep === "git" ? "Installing…" : "Install git"}
            </Button>
          {:else if installGit}
            <p class="text-pretty text-xs leading-relaxed font-secondary text-(--solus-text-secondary)">
              Installing git here needs elevation Solus doesn’t have. Run this on the host, then re-check:
            </p>
            <div class="mt-2 flex items-center gap-2">
              <code class="min-w-0 flex-1 truncate rounded-lg bg-(--solus-input-bg-soft) px-2 py-1.5 font-mono text-xs text-(--solus-text-primary)">
                {installGit.display}
              </code>
              <Button variant="outline" size="sm" onclick={() => void copy(installGit.display)}>
                <CopyIcon size={12} />
                Copy
              </Button>
            </div>
          {:else}
            <p class="text-pretty text-xs leading-relaxed font-secondary text-(--solus-text-secondary)">
              No package manager was found here. Install git on the host, then re-check.
            </p>
          {/if}
        {:else if openNote === "github"}
          {#if setup}<GitHostPanel {setup} />{/if}
        {:else if openNote === "agent"}
          <p class="text-pretty text-xs leading-relaxed font-secondary text-(--solus-text-secondary)">
            The project still opens — it just can’t run a session here until an agent CLI is installed.
          </p>
          {#if setup}<ProviderPanel {setup} />{/if}
        {:else if openNote === "identity"}
          <p class="text-pretty text-xs leading-relaxed font-secondary text-(--solus-text-secondary)">
            Commits made on this host use this name and email. Cloning works without it.
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <Input bind:value={identityName} class="h-8 min-w-40 flex-1 text-xs" placeholder="Name" aria-label="Git user name" />
            <Input bind:value={identityEmail} class="h-8 min-w-48 flex-1 text-xs" placeholder="you@example.com" aria-label="Git user email" />
            <Button
              disabled={!setup || setup.runningStep === "identity" || !identityName.trim() || !identityEmail.trim()}
              onclick={() => void setup?.setGitIdentity({ name: identityName.trim(), email: identityEmail.trim() })}
            >
              {setup?.runningStep === "identity" ? "Saving…" : "Save"}
            </Button>
          </div>
        {/if}

        {#if setup?.stepError && (openNote === "git" || openNote === "identity")}
          <p class="mt-2 text-pretty text-xs leading-relaxed text-(--solus-status-error)">{setup.stepError.message}</p>
        {/if}
      </div>
    {/if}
  </div>
{/if}
