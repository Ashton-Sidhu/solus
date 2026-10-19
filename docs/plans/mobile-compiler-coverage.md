# Mobile React Compiler coverage

The native app (`apps/mobile`) builds with the React Compiler. This plan names
what the compiler does to each component and hook, how a check keeps that
from getting worse without notice, and what the check cannot prove.

## Decision

- The compiler is on through the Expo flag `expo.experiments.reactCompiler`
  in `apps/mobile/app.json`. Expo CLI turns the flag into the transform option
  `reactCompiler: 'true'`, for `expo start` and for the release bundle
  (`expo export:embed`). `babel-preset-expo` then adds
  `babel-plugin-react-compiler` once. `babel.config.js` stays the plain preset:
  do not add the plugin to it, or it runs twice.
- `babel-preset-expo` declares the compiler plugin as its own dependency, so
  the app needs no package change for it.
- The compiler never runs on `node_modules`. Metro compiles
  `@solus/contracts` and `@solus/client-core` from source with the app's
  config, but they hold no React code. A test fails if one of them imports
  React.

## Vocabulary

- **Attempted function** — a component or hook the compiler tries to compile.
  In its default `infer` mode that is a function named like a component or a
  hook that renders JSX or calls a hook.
- **Compiled** — the compiler rewrote the function with its own memo cache.
- **Known skip** — an attempted function the compiler leaves as written, with
  the diagnostic categories that stopped it. The app still runs it, with its
  manual caches only. The compiler reports nothing at run time.
- **Reduction** — a function that stops compiling, or a compiled function that
  disappears. Coverage gets lower.

## The check

`bun scripts/check-mobile-compiler-coverage.ts` runs every module under
`apps/mobile/src` (and `index.ts`) through the installed Expo Metro Babel
transformer, with the options Expo CLI computes for a release bundle from the
app config, and the compiler on. A `.ios` or `.android` module runs for its
platform; a shared module runs for iOS.

The compiler reports outcomes only to a logger in its plugin options. A first
Babel plugin lends the compiler's plugin instance a logger for each file and
takes it back after; it writes nothing. The check compares the outcome of each
function, by name, with `scripts/mobile-compiler-coverage-baseline.json`, and
the installed versions of the toolchain with the versions the baseline records.

It also checks facts that must hold for any outcome:

- The compiler plugin ran for each module.
- Each compiled function with memo slots has one memo cache in the generated
  module. A module-level `'use no memo'` reports success but emits nothing; this
  catches it.

`tests/unit/native-mobile-compiler-coverage.test.ts` runs the same check in
the unit suite, the shipped flag, and the check's own logic on fixture modules.

### Commands

| Command | Use |
| --- | --- |
| `bun scripts/check-mobile-compiler-coverage.ts` | Check. Fails on any difference from the baseline. |
| `… --list` | Every known skip with its diagnostics and lines. |
| `… --update` | Write the baseline. Fixed skips and new compiled functions are recorded. |
| `… --update --accept=<path>#<function>` | Also record a reduction, after review. `--accept=<path prefix>` accepts every reduction in the files under it, for a move. |
| `… --semantics --all-platforms --report=<file.json>` | Evidence run: Android for shared modules too, the compiler-off build of each compiled module, and a report. |
| `… --source-root=<dir>` | Check a copy of the sources, such as a before snapshot, with the real `node_modules` linked in. |

The baseline only shrinks by itself. `--update` refuses a reduction that is not
named with `--accept`, so a reduction is a reviewed line in the baseline diff.

The semantics run also proves that the logger changed no output byte, that the
compiled module requires and exports what the compiler-off module does, and
that each compiled function maps back to its own source line.

### Toolchain updates

The baseline records `@babel/core`, `@expo/cli`, `@expo/metro-config`,
`babel-plugin-react-compiler`, `babel-preset-expo`, `react-native-reanimated`
and `react-native-worklets`. After a dependency update the check fails until
`--update` records the new versions. Run the evidence run again on the new
versions before that, and accept a reduction only with a reason.

## Migration rules

A skipped function keeps its manual `useMemo` and `useCallback`. Remove a manual
cache only after its function compiles and its lifetime is checked.

The compiler cannot lower these; each has a fix that keeps behavior:

| Diagnostic | Fix |
| --- | --- |
| `try`/`finally`, a branch or `throw` inside `try` | Move the body into an `async` arrow and settle it with `.catch` and `.finally`. The arrow turns a synchronous throw into a rejection, so the cleanup still runs for both. |
| A ref written during render to hold the latest value | Write it in `useLayoutEffect`. It runs before every passive effect of the same commit, so effects and handlers read the same value. |
| A ref that stores a value from an earlier render | Keep it in state and update it during render, guarded by an inequality. |
| A `ref` read through `props.ref` or `props.listRef` | Destructure it first. A read of any object that holds a ref counts as a ref read. |
| `props.onX(…)` with `[props.onX]` as dependency | Destructure the callback and call it plainly. A call through `props.` makes all of `props` the dependency. |
| A memo whose dependencies omit a value it reads | Add the value. The omission is also a stale-closure defect. |
| A Reanimated `sv.value = …` write | Use `sv.set(…)`. `set` passes an animation definition through unchanged. |
| A module variable changed in render (`nextKey++`) | Move the change into a module function. |

Some diagnostics come from the compiler's conservative inference, not from a
defect. A hook that receives a ref, or a ref-reading callback, returns a value
the compiler treats as a ref. A ref-reading callback passed to a constructor or
a gesture builder during render counts as a ref read. These need a design
change, so they stay known skips until one is made.

## Measurement

`tests/fixtures/mobile-workloads.ts` builds the data path of the feed: a long
conversation, a streamed reply, and the rows `ThreadFeed` derives.
`tests/unit/native-mobile-workloads.test.ts` holds what the compiled feed
relies on: a streamed chunk changes one transcript item and leaves the order,
so the feed does not derive its rows again. `bun scripts/measure-mobile-workloads.ts`
times those steps and records the machine's load. Bun on a desktop CPU is not
Hermes on a phone; compare two revisions on one machine only.

Equal store refreshes, feed size classes and the thread-list clock have their
own fixtures (store-stability and native-performance work, 19 October 2026).

## Runtime gates

A successful compile is not a speed measurement. These need a native build on
a device, and are not proved by the check or the fixtures:

- Render counts and commit times with the compiler on and off: typing in the
  composer, a streamed reply, scrolling a long feed, returning to a tab, and
  equal store refreshes. Use the React profiler on a development build and
  Hermes sampling on a release build.
- Behavior of each migrated function: failed and aborted writes still clear
  their busy state; end-follow and re-pin in the thread; the snooze clock and
  wake; the settled-list reset; the Plan mode toggle; the inspector pane
  animation; gestures and keyboard insets.
- An effect that relied on a new object identity each render to run again now
  runs less often. Watch for stale subscriptions and lists.
- Memory with the compiler's caches across long sessions and many mounted
  screens.
- The Android release bundle on a device. The check covers the Android
  transform of shared modules only in the evidence run.
