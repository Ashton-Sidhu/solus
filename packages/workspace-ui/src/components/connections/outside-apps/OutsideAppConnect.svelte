<script lang="ts">
  /** How an open row connects its app, once the host has an address the app
   *  reaches. An app whose handoff opens a page (the cloud apps, Cursor): the
   *  access switch, the handoff button, the code card, and the waiting line;
   *  "Set up another way" gives the address and the guide's steps instead. An
   *  app run from a terminal: its commands, which sign in on a page of their
   *  own. Another MCP app (no guide): the address, the access, and the code. */
  import { ArrowUpRight as OpenIcon, TriangleAlert as WarningIcon } from "@lucide/svelte";
  import type { AppAccess } from "@solus/contracts/host-api";
  import type { OutsideAppGuide } from "@solus/contracts/outside-apps";
  import { localApi } from "@solus/client-core/local-api";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import { DEFAULT_OUTSIDE_APP_ACCESS, OUTSIDE_APP_ACCESS_LEVELS, openOutsideApp, outsideAppAction, outsideAppFallback, type LinkOpener } from "../lib/outside-apps";
  import { commandsText } from "../lib/outside-apps-directory";
  import { outsideApps } from "./outside-apps.svelte";
  import OutsideAppCode from "./OutsideAppCode.svelte";
  import OutsideAppsCopyRow from "./OutsideAppsCopyRow.svelte";

  interface Props {
    serverId: string;
    hostName: string;
    /** Null for Another MCP app. */
    guide: OutsideAppGuide | null;
    mcpUrl: string;
    /** The host's local address, for the note under the commands; null when `mcpUrl` is it. */
    localUrl: string | null;
    /** Why the address was not proved to answer; null when it was. */
    warning: string | null;
    /** An app signed in since the row opened. */
    hasSignedIn: boolean;
  }

  let { serverId, hostName, guide, mcpUrl, localUrl, warning, hasSignedIn }: Props = $props();

  let access = $state<AppAccess>(DEFAULT_OUTSIDE_APP_ACCESS);
  let isAnotherWay = $state(false);
  let isCopied = $state(false);

  const opener: LinkOpener = {
    isWeb: localApi.getPlatform() === "web",
    openExternal: (url) => localApi.openExternal(url),
    assign: (url) => window.location.assign(url),
  };

  const appName = $derived(guide?.name ?? "the app");
  const action = $derived(guide ? outsideAppAction(guide, mcpUrl) : null);
  const message = $derived(guide?.handoff.kind === "copy-message" ? guide.handoff.message(mcpUrl) : null);
  const level = $derived(OUTSIDE_APP_ACCESS_LEVELS.find((candidate) => candidate.access === access) ?? OUTSIDE_APP_ACCESS_LEVELS[0]);

  function openLink(link: string) {
    void openOutsideApp({ link, appLink: null }, opener);
  }

  async function handOff(app: OutsideAppGuide, open: Extract<ReturnType<typeof outsideAppAction>, { kind: "open" }>) {
    if (open.copy) {
      // The app opens only once the copy lands, so it never reads an older clipboard.
      // A copy that fails shows the value to copy by hand, and the app does not open over it.
      if (!(await outsideApps.copy(app.handoff.kind === "copy-message" ? "message" : "address", open.copy.text))) return;
      const fallback = outsideAppFallback(open, app.name, opener.isWeb);
      toasts.success(open.copy.title, fallback ? { action: { label: fallback.label, onAction: () => openLink(fallback.link) } } : {});
    }
    if (!(await openOutsideApp(open, opener))) {
      toasts.error(`Could not open ${app.name}`, { description: "Use Set up another way." });
    }
  }

  async function copyCommands(commands: readonly string[]) {
    if (!(await outsideApps.copy("command", commandsText(commands)))) return;
    isCopied = true;
    setTimeout(() => (isCopied = false), 1500);
  }
</script>

{#snippet accessSwitch()}
  <fieldset class="flex flex-col gap-1.75">
    <legend class="sr-only">What can {appName} do?</legend>
    <div class="flex rounded-[0.5625rem] bg-muted p-0.75">
      {#each OUTSIDE_APP_ACCESS_LEVELS as option (option.access)}
        <label class="flex min-w-0 flex-1 cursor-pointer justify-center rounded-[0.4375rem] p-1.5 text-[0.8125rem] leading-4 font-medium text-(--solus-text-secondary) transition-colors hover:text-(--solus-text-primary) has-checked:bg-(--solus-container-bg) has-checked:font-semibold has-checked:text-(--solus-text-primary) has-checked:shadow-[0_1px_2px_color-mix(in_oklch,var(--foreground)_12%,transparent)] has-focus-visible:ring-3 has-focus-visible:ring-ring/50 pointer-coarse:min-h-11 pointer-coarse:items-center">
          <input type="radio" name="outside-app-access-{guide?.id ?? 'other'}" value={option.access} bind:group={access} class="sr-only" />
          <span class="truncate">{option.label}</span>
        </label>
      {/each}
    </div>
    <p class="text-chrome-dense text-pretty text-(--solus-text-tertiary)">{level.effect}</p>
  </fieldset>
{/snippet}

{#snippet waiting()}
  <p class="flex items-center gap-2 text-[0.8125rem] leading-4 text-(--solus-text-tertiary)" role="status">
    {#if hasSignedIn}
      <span aria-hidden="true" class="size-1.75 shrink-0 rounded-full bg-(--solus-status-complete)"></span>
      <span class="text-(--solus-status-complete)">{appName} signed in</span>
    {:else}
      <span aria-hidden="true" class="size-1.75 shrink-0 rounded-full bg-(--warning)"></span>
      Waiting for {appName} to sign in
    {/if}
  </p>
{/snippet}

{#snippet anotherWayLink(label: string)}
  <button
    type="button"
    class="shrink-0 text-[0.8125rem] leading-4 font-medium text-(--solus-text-secondary) underline-offset-4 outline-none hover:text-(--solus-text-primary) hover:underline focus-visible:underline"
    onclick={() => (isAnotherWay = !isAnotherWay)}
  >
    {label}
  </button>
{/snippet}

<div class="flex flex-col gap-4">
  {#if warning}
    <p role="status" class="flex items-start gap-2 text-chrome-dense text-(--solus-text-secondary)">
      <WarningIcon size={16} class="mt-px shrink-0 text-(--warning)" />
      <span>Not proved from outside: {warning}</span>
    </p>
  {/if}

  {#if guide && action?.kind === "commands"}
    <p class="text-[0.8125rem] leading-[1.45] text-(--solus-text-secondary)">
      Run these where {guide.name} runs. {guide.name} opens a sign-in page; approve it there.
      {#if guide.note}{guide.note}{/if}
    </p>
    <pre class="overflow-x-auto rounded-[0.625rem] bg-neutral-900 px-3.5 py-3 font-mono text-[0.75rem] leading-4.5 whitespace-pre-wrap break-all text-neutral-100 select-text dark:bg-black/45">{commandsText(action.commands)}</pre>
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <Button variant="ghost" size="xs" class="-ml-2 text-[0.8125rem] text-primary hover:text-primary" onclick={() => void copyCommands(action.commands)}>
        {isCopied ? "Copied" : "Copy commands"}
      </Button>
      <span class="text-[0.8125rem] leading-4 text-(--solus-text-tertiary)">
        {localUrl ? `On ${hostName} itself? Use ${localUrl} instead.` : `Uses localhost: run them on ${hostName}.`}
      </span>
    </div>
  {:else if guide && action?.kind === "open" && !isAnotherWay}
    {@const open = action}
    {@render accessSwitch()}
    <div class="flex flex-col gap-2">
      <Button class="h-10 w-full rounded-[0.625rem] text-[0.875rem] font-semibold" onclick={() => void handOff(guide, open)}>
        {open.label}
        <OpenIcon size={14} />
      </Button>
      {#if guide.note}
        <p class="text-chrome-dense text-(--solus-text-tertiary)">{guide.note}</p>
      {/if}
    </div>
    <OutsideAppCode {serverId} {access} appName={guide.name} />
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      {@render waiting()}
      {@render anotherWayLink("Set up another way")}
    </div>
  {:else}
    <!-- Another MCP app, or "Set up another way": the address, and the steps to add it by hand. -->
    <OutsideAppsCopyRow label="Address" kind="address" value={mcpUrl} />
    {#if message}
      <OutsideAppsCopyRow label="Message" kind="message" value={message} />
    {/if}
    <ol class="flex list-decimal flex-col gap-1 pl-5 text-[0.8125rem] leading-[1.45] text-(--solus-text-secondary)">
      {#each guide?.steps ?? ["Add a remote MCP server with OAuth, and paste the address."] as step (step)}
        <li>{step}</li>
      {/each}
    </ol>
    {#if guide?.docs}
      {@const docs = guide.docs}
      <div>
        <button
          type="button"
          class="text-[0.8125rem] text-(--solus-text-secondary) underline-offset-4 outline-none hover:text-(--solus-text-primary) hover:underline focus-visible:underline"
          onclick={() => openLink(docs)}
        >
          {guide.name} help
        </button>
      </div>
    {:else if !guide}
      <p class="text-chrome-dense text-(--solus-text-tertiary)">Apps that require their own client ID cannot connect.</p>
    {/if}
    {@render accessSwitch()}
    <OutsideAppCode {serverId} {access} appName={guide?.name ?? "the app"} />
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      {@render waiting()}
      {#if guide}{@render anotherWayLink("Back to one click")}{/if}
    </div>
  {/if}
</div>
