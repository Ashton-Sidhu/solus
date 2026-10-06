<script lang="ts">
  import type { Snippet } from "svelte";
  import type { DeviceToolVersions } from "@solus/contracts/device-types";
  import * as Popover from "../ui/popover";
  import { Button } from "../ui/button";
  import { shownToolVersion } from "./lib/device-settings";

  /**
   * A device host's tool versions as one quiet chip, with the details in a
   * popover (adapted from T3 Code `apps/web/src/components/device/DeviceToolVersions.tsx`, MIT).
   * With `kind` the chip names that tool's version; without it, both tools.
   */

  let { tools, kind, error, action }: {
    tools: DeviceToolVersions | undefined;
    kind?: keyof DeviceToolVersions;
    error?: string;
    /** Sits under the details: Install or Update when this host can do it. */
    action?: Snippet;
  } = $props();

  const NAMES = { hub: "Device hub", agent: "Agent tools" } as const;
  const selected = $derived(kind ? tools?.[kind] : undefined);
  const version = $derived(selected ? shownToolVersion(selected) : null);
  const chip = $derived(
    kind
      ? version ? `v${version}` : selected ? "Not installed" : "Version unknown"
      : error ? "Versions unavailable" : "Versions",
  );
  const rows = $derived(
    tools ? (["hub", "agent"] as const).filter((name) => !kind || name === kind).map((name) => ({ name, tool: tools[name] })) : [],
  );
</script>

<Popover.Root>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button {...props} size="xs" variant="ghost" class="font-normal text-muted-foreground"
        aria-label={kind ? `${NAMES[kind]}: ${chip}. Show details` : undefined}>{chip}</Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content side="bottom" align="end" sideOffset={6} class="w-80 gap-0 p-3">
    <p class="font-medium">{kind ? NAMES[kind] : "Device tools"}</p>
    {#if rows.length}
      <div class="mt-3 divide-y divide-border/50">
        {#each rows as { name, tool } (name)}
          <div class="space-y-2 py-3 first:pt-0 last:pb-0">
            {#if !kind}<p class="text-xs font-medium">{NAMES[name]}</p>{/if}
            <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs">
              <dt class="text-muted-foreground">Running</dt>
              <dd class="text-right font-mono">{tool.runningVersion ?? "Not running"}</dd>
              <dt class="text-muted-foreground">Required</dt>
              <dd class="text-right font-mono">{tool.requiredVersion}</dd>
              <dt class="text-muted-foreground">Installed</dt>
              <dd class="text-right font-mono break-words">{tool.installedVersions.join(", ") || "None"}</dd>
            </dl>
          </div>
        {/each}
      </div>
    {:else}
      <p class="mt-2 text-xs text-muted-foreground">Versions have not been checked.</p>
    {/if}
    {#if error}<p role="status" class="mt-3 text-xs text-destructive">{error}</p>{/if}
    {#if action}<div class="mt-3 border-t border-border/50 pt-3">{@render action()}</div>{/if}
  </Popover.Content>
</Popover.Root>
