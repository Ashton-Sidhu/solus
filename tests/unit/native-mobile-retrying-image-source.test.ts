// Adapted from T3 Code apps/mobile/src/native/useRetryingImageSource.test.tsx (MIT, see apps/mobile/UPSTREAM.md).
// Enriched t3.16 asks about each image once and ignores a new resolver. The Solus
// resolvers throw while the host's media is unavailable and are replaced when it
// returns, so an image that failed during a reconnect must ask the next resolver
// instead of keeping its placeholder until the message remounts.
import { afterEach, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

// react-dom carries its own React; the hook under test must share it.
const requireFromReactDom = createRequire(createRequire(import.meta.url).resolve("react-dom/package.json"));
const React = requireFromReactDom("react") as typeof import("react");
mock.module("react", () => React);
const { createElement, useLayoutEffect } = React;

const { useRetryingImageSource } = await import("../../apps/mobile/src/native/useRetryingImageSource");
type MarkdownImageSourceResolver = import("../../apps/mobile/src/native/SelectableMarkdownText.types").MarkdownImageSourceResolver;

const dom = new JSDOM("<!doctype html><body></body>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = requireFromReactDom("react-dom/client") as typeof import("react-dom/client");
const act = React.act;

let resolveImage: ReturnType<typeof useRetryingImageSource>;

function Probe(props: { readonly resolve: MarkdownImageSourceResolver }) {
  const resolver = useRetryingImageSource(props.resolve);
  useLayoutEffect(() => {
    resolveImage = resolver;
  });
  return null;
}

const root = createRoot(document.createElement("div"));
afterEach(async () => act(async () => root.unmount()));

test("an image the unavailable resolver failed asks the next resolver", async () => {
  const unavailable: MarkdownImageSourceResolver = async () => {
    throw new Error("Markdown image is unavailable");
  };
  await act(async () => root.render(createElement(Probe, { resolve: unavailable })));
  const askedOnce = resolveImage!;

  let source: unknown = "pending";
  const answered = askedOnce({ id: "img:0:0", url: "assets/shot.png", altText: "", title: "", placement: "inline" }).then(
    (value) => {
      source = value;
    },
  );
  await act(async () => {});
  expect(source).toBe("pending");

  const available: MarkdownImageSourceResolver = async (image) => ({ uri: `https://host/${image.href}` });
  await act(async () => root.render(createElement(Probe, { resolve: available })));
  await answered;

  expect(source).toEqual({ uri: "https://host/assets/shot.png" });
  // Enriched reads the resolver like an event handler; its identity must not change.
  expect(resolveImage).toBe(askedOnce);
});
