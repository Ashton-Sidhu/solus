import { getContext, hasContext, setContext } from "svelte";

interface OuterScrollbarContext {
  register: (element: HTMLElement) => () => void;
}

const outerScrollbarContextKey = Symbol("outer-scrollbar");

export function provideOuterScrollbarContext(context: OuterScrollbarContext) {
  setContext(outerScrollbarContextKey, context);
}

export function getOuterScrollbarContext() {
  return hasContext(outerScrollbarContextKey)
    ? getContext<OuterScrollbarContext>(outerScrollbarContextKey)
    : null;
}
