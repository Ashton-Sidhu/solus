import DOMPurify from "dompurify";
import type { DiagramType, MountOptions, Mounted } from "pele/lazy";
import type { Action } from "svelte/action";

/** How a fenced ```mermaid block reads is the document model's rule, so a
 *  reply and a document make the same choice. */
export { isMermaidFence, mermaidRenderMode, MERMAID_SOURCE_INFO, type MermaidRenderMode } from "@solus/document-model/fences";

export type Pele = typeof import("pele/lazy");

// Pele is a small chunk, and each diagram type is its own chunk after it, so a
// conversation with one flowchart loads only the flowchart parser and layout.
// Nothing loads before the first diagram. A failed load is not kept, so the
// next diagram tries again.
let coreLoad: Promise<Pele> | null = null;
const typeLoads = new Map<DiagramType, Promise<boolean>>();

function loadCore(): Promise<Pele> {
  coreLoad ??= import("pele/lazy");
  const load = coreLoad;
  load.catch(() => {
    if (coreLoad === load) coreLoad = null;
  });
  return load;
}

function loadType(pele: Pele, type: DiagramType): Promise<boolean> {
  let load = typeLoads.get(type);
  if (!load) {
    load = pele.load(type);
    typeLoads.set(type, load);
    load.catch(() => typeLoads.delete(type));
  }
  return load;
}

/** Warm the renderer while a Mermaid fence is still streaming.
 * Loading failures are reported by loadDiagramRenderer when the fence closes. */
export function preloadMermaid(): void {
  void loadCore().catch(() => {});
}

/** Pele with the chunk for this diagram's type, or null when a chunk did not
 *  load. A source of no known type still gets Pele, whose parser says why. */
export async function loadDiagramRenderer(source: string): Promise<Pele | null> {
  try {
    const pele = await loadCore();
    let type: DiagramType | null = null;
    try {
      type = pele.detectType(source);
    } catch {
      // An unknown type falls through to the mount, which reports it.
    }
    if (type) await loadType(pele, type);
    return pele;
  } catch {
    return null;
  }
}

let purifier: ReturnType<typeof DOMPurify> | null = null;

// A diagram can come from an untrusted pull request or task body. Pele escapes
// labels, and links and images are off, so this is defense in depth against
// anything that could navigate, run script, or fetch remote content.
function sanitizeDiagramSvg(svg: string): Node {
  purifier ??= DOMPurify(window);
  return purifier.sanitize(svg, {
    FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
    FORBID_TAGS: ["a", "image", "foreignObject", "style"],
    USE_PROFILES: { svg: true, svgFilters: true },
    RETURN_DOM_FRAGMENT: true,
  });
}

/** The message the parser raised, without the caret diagram that only reads
 *  in a monospace pane. */
export function describeDiagramError(message: string): string {
  const lines = message.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  const expecting = lines.find((line) => line.startsWith("Expecting"));
  return expecting ? `${lines[0]} ${expecting}` : (lines[0] ?? "This diagram could not be drawn.");
}

export interface MermaidDiagramParams {
  pele: Pele;
  source: string;
  onRender: () => void;
  onError: (message: string) => void;
}

/**
 * Draws Mermaid text into the element with Pele's `mount`. Pele parses once
 * and keeps the model. It draws nothing while the element has no width (a
 * hidden tab), so a diagram there costs nothing until it shows. It lays the
 * diagram out again, at most once a frame, only when the element is narrower
 * than the diagram and the layout changes, so a narrow pane wraps labels
 * instead of shrinking them. It measures labels in the element's font and
 * measures again when web fonts finish loading. Colours are `--pele-*`
 * variables (the `.pele` rules in workspace.css), so a theme change needs no
 * new render.
 */
export const mermaidDiagram: Action<HTMLElement, MermaidDiagramParams> = (element, initial) => {
  let params = initial;
  const options = (): MountOptions => ({
    links: false,
    images: false,
    zoom: false,
    // Keep the author's direction; a wide diagram scales down to fit instead of turning vertical.
    autoDirection: false,
    fontSize: 14,
    sanitize: sanitizeDiagramSvg,
    onRender: () => params.onRender(),
    onError: (error) =>
      params.onError(describeDiagramError(error instanceof Error ? error.message : String(error))),
  });
  let mounted: Mounted = params.pele.mount(element, params.source.trim(), options());
  return {
    // New text mounts again rather than calling `update`: a first mount always
    // draws, while `update` waits for width, and a diagram hidden after a parse
    // error has none until it draws.
    update(next) {
      const source = next.source.trim();
      const isNewDiagram = next.pele !== params.pele || source !== mounted.source;
      params = next;
      if (!isNewDiagram) return;
      mounted.destroy();
      mounted = params.pele.mount(element, source, options());
    },
    destroy() {
      mounted.destroy();
    },
  };
};
