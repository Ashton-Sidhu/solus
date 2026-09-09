<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import type { Snippet } from "svelte";
  import { toasts } from "../../lib/toasts";
  import * as ContextMenu from "../ui/context-menu";

  let { href, title, onclick, onOpenInSolus, children }: {
    href: string;
    title?: string;
    onclick: (event: MouseEvent) => void;
    onOpenInSolus: () => void;
    children: Snippet;
  } = $props();

  let open = $state(false);
  let link: HTMLAnchorElement;

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const rect = link.getBoundingClientRect();
    link.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left,
      clientY: rect.bottom,
    }));
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(href);
    } catch {
      toasts.error("Couldn't copy the link");
    }
  }
</script>

<ContextMenu.Root bind:open>
  <ContextMenu.Trigger>
    {#snippet child({ props })}
      <a
        {...props}
        bind:this={link}
        {href}
        {title}
        tabindex="0"
        class="solus-link [-webkit-touch-callout:none]"
        onclick={(event) => {
          if (open) event.preventDefault();
          else onclick(event);
        }}
        onkeydown={handleKeydown}
      >{@render children()}</a>
    {/snippet}
  </ContextMenu.Trigger>
  <ContextMenu.Content
    collisionPadding={8}
    onCloseAutoFocus={(event) => { event.preventDefault(); link.focus(); }}
  >
    <ContextMenu.Item onSelect={onOpenInSolus}>Open in Solus</ContextMenu.Item>
    <ContextMenu.Item onSelect={() => localApi.openExternal(href)}>Open in default browser</ContextMenu.Item>
    <ContextMenu.Separator />
    <ContextMenu.Item onSelect={copyLink}>Copy Link</ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>
