<script lang="ts">
  import type { Snippet } from "svelte";

  import { ACCOUNT_SETTINGS_PATHS, type AccountSettingsPageId } from "@solus/contracts/account-web";

  let { page, children }: { page: AccountSettingsPageId; children: Snippet } = $props();
  const sections = [
    { id: "appearance", label: "Appearance", href: ACCOUNT_SETTINGS_PATHS.appearance },
    { id: "agent-profile", label: "Agent Profile", href: ACCOUNT_SETTINGS_PATHS["agent-profile"] },
    { id: "connections", label: "Connections", href: ACCOUNT_SETTINGS_PATHS.connections },
  ] as const;
  const current = $derived(sections.find((section) => section.id === page)!);
</script>

<svelte:head><title>{current.label} — Solus</title></svelte:head>
<main class="@container h-dvh overflow-y-auto bg-background text-foreground">
  <div class="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
    <a href="/" data-sveltekit-reload class="self-start text-workspace-chrome text-muted-foreground hover:underline">Back to workspace</a>
    <div class="flex flex-col gap-6 @2xl:flex-row">
      <nav aria-label="Account settings" class="flex shrink-0 flex-wrap gap-1 @2xl:w-44 @2xl:flex-col">
        {#each sections as section (section.id)}
          <a href={section.href} data-sveltekit-reload aria-current={section.id === page ? "page" : undefined}
            class="rounded-md px-3 py-2 text-workspace-chrome text-muted-foreground hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:text-foreground">{section.label}</a>
        {/each}
      </nav>
      <div class="flex min-w-0 flex-1 flex-col gap-6">
        <h1 class="text-h1 font-semibold">{current.label}</h1>
        {@render children()}
      </div>
    </div>
  </div>
</main>
