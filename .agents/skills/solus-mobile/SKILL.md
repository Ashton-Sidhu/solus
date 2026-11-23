---
name: solus-mobile
description: Connect T3 Code mobile features to the Solus host, or import upstream updates while preserving the T3 interface.
---

Start with the T3 screen and its normal entry points in `apps/mobile/src/features`. Keep the T3 frontend, including navigation, layout, controls, gestures, and visual states. Connect its data and commands to the selected Solus host through the typed RPC API and the mobile stores. Reuse the same screen for phone and tablet entry points where upstream does so.

Read `apps/mobile/UPSTREAM.md` before an upstream update. Compare the new T3 revision with the previous import. Keep Solus branding and existing product decisions. Ask before substituting a different screen or changing a user interaction. Verify both the upstream interaction and the Solus data that drives it.

Reuse the T3 client code below the screens too. Start with its navigation subscription, list state, history controls, and conversation feed builder. Translate Solus records and live events at their inputs. Keep host authorization, transport, and Solus-specific cards in the adapter. When a change affects loading, check first readable content with both empty and saved phone caches.

Apply this rule across the app, including projects, files, Git, pull requests, issues, archive, settings, browsers, and devices. Trace the active phone and tablet routes to the typed host read, write, or event. Compare that path with the upstream revision in `apps/mobile/UPSTREAM.md`. Keep the upstream state and interaction code on the client side of the adapter. This includes cache ownership and freshness, partial results from multiple hosts, paging, retries, and selection after updates. Remove parallel feature loaders and selectors when the upstream implementation can consume translated data.

Key host data and outstanding requests by their account, organization, host, and connection as applicable. Preserve host permission checks and keep signed resource URLs within their scope. Keep a Solus-specific adapter where the host owns a different operation, such as pairing, provider sign-in, or device control. Document that difference. Exercise the real entry point with cold and warm data. Check that an old reply cannot populate a new scope. Measure on comparable devices and data before claiming performance parity.
