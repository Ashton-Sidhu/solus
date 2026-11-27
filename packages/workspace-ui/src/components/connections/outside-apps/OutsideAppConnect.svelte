<script lang="ts">
  /** How an open row connects its app, once the host has an address the app
   *  reaches. An app whose handoff opens a page (the cloud apps, Cursor): the
   *  access switch, the handoff button, the code card, and the waiting line;
   *  "Set up another way" gives the address and the guide's steps instead. An
   *  app run from a terminal: its commands, which sign in on a page of their
   *  own. Another MCP app (no guide): the address, the access, and the code. */
  import { ArrowUpRight as OpenIcon, ChevronDown as ChevronDownIcon, LoaderCircle as SpinnerIcon, TriangleAlert as WarningIcon } from "@lucide/svelte";
  import type { AppAccess } from "@solus/contracts/host-api";
  import type { OutsideAppGuide } from "@solus/contracts/outside-apps";
  import { localApi } from "@solus/client-core/local-api";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import { DEFAULT_OUTSIDE_APP_ACCESS, OUTSIDE_APP_ACCESS_LEVELS, openOutsideApp, outsideAppAction, outsideAppFallback, type LinkOpener } from "../lib/outside-apps";
  import { commandsText } from "../lib/outside-apps-directory";
  import { outsideApps } from "./outside-apps.svelte";
  import OutsideAppCode from "./OutsideAppCode.svelte";
  import OutsideAppsCopyRow from "./OutsideAppsCopyRow.svelte";
  import StepRail from "../../steps/StepRail.svelte";
  import { anotherWaySteps } from "../lib/another-way-steps";

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
  /** What "Set up another way" saw the person copy: it marks that step done. */
  let copied = $state<"address" | "message" | null>(null);
  let isCopied = $state(false);

  const opener: LinkOpener = {
    isWeb: localApi.getPlatform() === "web",
    openExternal: (url) => localApi.openExternal(url),
    assign: (url) => window.location.assign(url),
  };

  const appName = $derived(guide?.name ?? "the app");
  const action = $derived(guide ? outsideAppAction(guide, mcpUrl) : null);
  const message = $derived(guide?.handoff.kind === "copy-message" ? guide.handoff.message(mcpUrl) : null);
  const anotherSteps = $derived(anotherWaySteps(guide, message !== null, { copied, hasSignedIn }));
  const level = $derived(OUTSIDE_APP_ACCESS_LEVELS.find((candidate) => candidate.access === access) ?? OUTSIDE_APP_ACCESS_LEVELS[0]);

  function chooseAccess(value: string) {
    const chosen = OUTSIDE_APP_ACCESS_LEVELS.find((candidate) => candidate.access === value);
    if (chosen) access = chosen.access;
  }

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

<!-- The access, as a sentence: the level is a choice inside it that opens the app's menu, one row per level with what it allows. -->
{#snippet accessSwitch()}
  <div class="flex flex-col gap-1">
    <p class="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[0.875rem] leading-6 text-(--solus-text-secondary)">
      <span>{guide?.name ?? "The app"} can</span>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              aria-label="What {appName} can do: {level.label}"
              class="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-px font-medium text-(--solus-text-primary) outline-none hover:bg-(--wash-3) focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-(--wash-3) pointer-coarse:min-h-11"
            >
              {level.phrase}<ChevronDownIcon size={13} class="text-(--solus-text-tertiary)" />
            </button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="start" sideOffset={6} collisionPadding={8} class="w-[min(22rem,calc(100vw-2rem))]">
          <DropdownMenu.RadioGroup value={access} onValueChange={chooseAccess}>
            {#each OUTSIDE_APP_ACCESS_LEVELS as option (option.access)}
              <DropdownMenu.RadioItem value={option.access} class="items-start py-2 pr-7">
                <span class="flex min-w-0 flex-col gap-0.5">
                  <span class="font-medium text-(--solus-text-primary)">{option.label}</span>
                  <span class="text-chrome-dense text-pretty whitespace-normal text-(--solus-text-tertiary)">{option.effect}</span>
                </span>
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      <span>on {hostName}.</span>
    </p>
    <p class="text-chrome-dense text-pretty text-(--solus-text-tertiary)">{level.effect}</p>
  </div>
{/snippet}

{#snippet waiting()}
  <p class="flex items-center gap-2 text-[0.8125rem] leading-4 text-(--solus-text-tertiary)" role="status">
    {#if hasSignedIn}
      <span aria-hidden="true" class="size-1.75 shrink-0 rounded-full bg-(--solus-status-complete)"></span>
      <span class="text-(--solus-status-complete)">{appName} signed in</span>
    {:else}
      <SpinnerIcon size={14} aria-hidden="true" class="shrink-0 motion-safe:animate-spin" />
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
      <Button variant="ghost" size="sm" class="self-start bg-muted" onclick={() => void copyCommands(action.commands)}>
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
      <Button class="self-start" onclick={() => void handOff(guide, open)}>
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
    <!-- Another MCP app, or "Set up another way": one timeline. The app's own steps, with the
         address or the message on the step that uses it, then the code, then the sign-in. -->
    <div class="text-[0.875rem]">
      <StepRail steps={anotherSteps}>
        {#snippet detail(step)}
          {#if step.attachment === "address"}
            <div class="mt-2"><OutsideAppsCopyRow label="Address" kind="address" value={mcpUrl} onCopied={() => (copied = "address")} /></div>
          {:else if step.attachment === "message" && message}
            <div class="mt-2"><OutsideAppsCopyRow label="Message" kind="message" value={message} onCopied={() => (copied = "message")} /></div>
          {:else if step.attachment === "code"}
            <div class="mt-2 flex flex-col gap-3">
              {@render accessSwitch()}
              <OutsideAppCode {serverId} {access} appName={guide?.name ?? "the app"} />
            </div>
          {/if}
        {/snippet}
      </StepRail>
    </div>
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      {#if guide?.docs}
        {@const docs = guide.docs}
        <button
          type="button"
          class="text-[0.8125rem] text-(--solus-text-secondary) underline-offset-4 outline-none hover:text-(--solus-text-primary) hover:underline focus-visible:underline"
          onclick={() => openLink(docs)}
        >
          {guide.name} help
        </button>
      {:else if !guide}
        <p class="text-chrome-dense text-(--solus-text-tertiary)">Apps that require their own client ID cannot connect.</p>
      {:else}
        <span></span>
      {/if}
      {#if guide}{@render anotherWayLink("Back to one click")}{/if}
    </div>
  {/if}
</div>
