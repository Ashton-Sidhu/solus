<script lang="ts">
  import { useSvelteFlow, getNodesBounds, getViewportForBounds } from '@xyflow/svelte'
  import { toPng, toSvg } from 'html-to-image'
  import { serializeDiagram } from '../../../shared/diagram-types'
  import { serializeMermaid } from '../../../shared/diagram-mermaid'
  import type { DiagramDoc } from '../../../shared/diagram-types'
  import PopoverMenu from './PopoverMenu.svelte'
  import { toasts } from '../../contexts/toast.store.svelte'

  interface Props {
    getDoc: () => DiagramDoc
    bgColor: string
    title: string
  }

  let { getDoc, bgColor, title }: Props = $props()

  const flow = useSvelteFlow()

  // Padding (px) added around the graph bounds, and the floor on the exported
  // image's dimensions so a tiny graph still renders at a usable size.
  const EXPORT_PADDING = 80
  const EXPORT_MIN_WIDTH = 240
  const EXPORT_MIN_HEIGHT = 180

  function slug(s: string): string {
    return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'diagram'
  }

  // Frame the whole graph and render the viewport element to an image. The
  // viewport contains only nodes + edges, so minimap/controls/background chrome
  // is naturally excluded from the capture.
  async function renderViewport(
    encode: (el: HTMLElement, opts: Record<string, unknown>) => Promise<string>,
    transparent = false,
  ): Promise<string | null> {
    const nodes = flow.getNodes()
    if (!nodes.length) return null
    const el = document.querySelector<HTMLElement>('.svelte-flow__viewport')
    if (!el) return null

    const bounds = getNodesBounds(nodes)
    const imageWidth = Math.max(Math.round(bounds.width) + EXPORT_PADDING, EXPORT_MIN_WIDTH)
    const imageHeight = Math.max(Math.round(bounds.height) + EXPORT_PADDING, EXPORT_MIN_HEIGHT)
    const viewport = getViewportForBounds(bounds, imageWidth, imageHeight, 0.2, 2.5, 0.12)

    return encode(el, {
      backgroundColor: transparent ? undefined : bgColor,
      width: imageWidth,
      height: imageHeight,
      style: {
        width: `${imageWidth}px`,
        height: `${imageHeight}px`,
        transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
      },
    })
  }

  function triggerDownload(dataUrl: string, ext: string) {
    const a = document.createElement('a')
    a.download = `${slug(title)}.${ext}`
    a.href = dataUrl
    a.click()
  }

  // Every action reports its outcome: rendering and the clipboard API can both
  // reject (permissions, tainted canvas), and silence is indistinguishable from
  // success for actions whose result lives outside the app.
  async function savePng() {
    try {
      const url = await renderViewport(toPng as never)
      if (!url) {
        toasts.info('Nothing to export — the diagram is empty')
        return
      }
      triggerDownload(url, 'png')
    } catch {
      toasts.error('PNG export failed')
    }
  }

  async function saveSvg() {
    try {
      const url = await renderViewport(toSvg as never, true)
      if (!url) {
        toasts.info('Nothing to export — the diagram is empty')
        return
      }
      triggerDownload(url, 'svg')
    } catch {
      toasts.error('SVG export failed')
    }
  }

  async function copyImage() {
    try {
      const url = await renderViewport(toPng as never)
      if (!url) {
        toasts.info('Nothing to copy — the diagram is empty')
        return
      }
      const blob = await (await fetch(url)).blob()
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      toasts.success('Image copied')
    } catch {
      toasts.error('Copy failed')
    }
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(serializeDiagram(getDoc()))
      toasts.success('JSON copied')
    } catch {
      toasts.error('Copy failed')
    }
  }

  async function copyMermaid() {
    try {
      await navigator.clipboard.writeText(serializeMermaid(getDoc()))
      toasts.success('Mermaid copied')
    } catch {
      toasts.error('Copy failed')
    }
  }
</script>

<PopoverMenu title="Export diagram" ariaLabel="Export diagram">
  {#snippet icon()}
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M8 2v8M5 7l3 3 3-3" />
      <path d="M2.5 11.5v1a1 1 0 001 1h9a1 1 0 001-1v-1" />
    </svg>
  {/snippet}

  {#snippet children(close)}
    <button type="button" class="popover__item" role="menuitem" onclick={() => { savePng(); close() }}>Save as PNG</button>
    <button type="button" class="popover__item" role="menuitem" onclick={() => { saveSvg(); close() }}>Save as SVG</button>
    <button type="button" class="popover__item" role="menuitem" onclick={() => { copyImage(); close() }}>Copy image</button>
    <span class="popover__divider" aria-hidden="true"></span>
    <button type="button" class="popover__item" role="menuitem" onclick={() => { copyJson(); close() }}>Copy as JSON</button>
    <button type="button" class="popover__item" role="menuitem" onclick={() => { copyMermaid(); close() }}>Copy as Mermaid</button>
  {/snippet}
</PopoverMenu>
