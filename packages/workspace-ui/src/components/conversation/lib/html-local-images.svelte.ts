import type { IpcContext } from "@solus/contracts/types";
import { resolveHostMediaUrl } from "../../../lib/host-media-url.svelte";
import { inlineLocalImages, localImageReferences } from "@solus/contracts/html-local-images";

/** The host an HTML block's local images are read from. */
export interface HtmlImageHost {
  serverId: string;
  ctx?: IpcContext;
}

async function loadHostImage(host: HtmlImageHost, path: string): Promise<Blob | null> {
  const url = await resolveHostMediaUrl({ serverId: host.serverId, path, ctx: host.ctx });
  const response = await fetch(url);
  return response.ok ? response.blob() : null;
}

/**
 * An HTML block's markup with its local images written in. Create it during
 * component setup. `html` is null while the images load, so the frame loads
 * the page once with its images rather than once without and again with them.
 * Markup with no local image, or with no host to read from, is ready at once.
 */
export class HtmlWithLocalImages {
  private inlined = $state<{ source: string; html: string } | null>(null);
  private readonly source: () => string;
  private readonly host: () => HtmlImageHost | null;
  private readonly hasLocalImages = $derived.by(
    () => this.host() !== null && localImageReferences(this.source()).size > 0,
  );

  constructor(source: () => string, host: () => HtmlImageHost | null) {
    this.source = source;
    this.host = host;
    $effect(() => {
      const html = this.source();
      const target = this.host();
      if (!target || !this.hasLocalImages) return;
      let cancelled = false;
      void inlineLocalImages(html, (path) => loadHostImage(target, path)).then((inlined) => {
        if (!cancelled) this.inlined = { source: html, html: inlined.html };
      });
      return () => {
        cancelled = true;
      };
    });
  }

  get html(): string | null {
    const source = this.source();
    if (this.inlined?.source === source) return this.inlined.html;
    return this.hasLocalImages ? null : source;
  }
}
