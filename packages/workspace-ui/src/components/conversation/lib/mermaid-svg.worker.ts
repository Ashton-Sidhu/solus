import { NATIVE_DIAGRAM_OPTIONS, scopeDiagramSvg, type NativeDiagramReply, type NativeDiagramRequest } from "./mermaid-svg";

// Draws a diagram with beautiful-mermaid off the main thread. It needs no DOM,
// so layout (ELK) and SVG assembly cost the workspace nothing.

// ELK's bundle reads "no `document`, has `self`" as "I am ELK's own worker"
// and takes over `onmessage`. A stub `document` keeps it on its in-process
// path, and beautiful-mermaid then reassigns `self`, which a worker only
// exposes as a getter until it is an own property.
Object.assign(globalThis, { document: {} });
Object.defineProperty(globalThis, "self", { value: globalThis, writable: true, configurable: true });
// Imported after the stubs, which a static import would not guarantee.
const rendererLoaded = import("beautiful-mermaid");

// The workspace compiles against DOM types, where `postMessage` is a window's.
const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<NativeDiagramRequest>) => void) | null;
  postMessage(reply: NativeDiagramReply): void;
};

workerScope.onmessage = async (event) => {
  const { requestId, source } = event.data;
  let reply: NativeDiagramReply;
  try {
    const { renderMermaidSVG } = await rendererLoaded;
    const svg = renderMermaidSVG(source, NATIVE_DIAGRAM_OPTIONS);
    reply = { requestId, svg: scopeDiagramSvg(svg, `solus-diagram-${requestId}`) };
  } catch (error) {
    reply = { requestId, error: error instanceof Error ? error.message : String(error) };
  }
  workerScope.postMessage(reply);
};
