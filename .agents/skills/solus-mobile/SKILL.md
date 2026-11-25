---
name: solus-mobile
description: Connect T3 Code mobile features to the Solus host, or import upstream updates while preserving the T3 interface.
---

Start with the T3 screen and its normal entry points in `apps/mobile/src/features`. Keep the T3 frontend, including navigation, layout, controls, gestures, and visual states. Identify the typed requests, responses, and events that the upstream client uses. Implement their translation on the selected Solus host. Reuse the same screen for phone and tablet entry points where upstream does so.

Follow `apps/mobile/AGENTS.md` for all mobile work. Keep the app as close as possible to the upstream T3 Code revision listed in `apps/mobile/UPSTREAM.md`. Before adding custom mobile logic or changing an upstream interaction, identify the upstream code you checked, explain the need for the change, and get explicit maintainer approval. Record approved differences in `apps/mobile/UPSTREAM.md`.

Before an upstream update, compare the new T3 revision with the previous import. Keep Solus branding and existing product decisions. Verify both the upstream interaction and the Solus data that drives it.

Reuse the T3 client code below the screens too. Start with its navigation subscription, list state, history controls, and conversation feed builder. Have the host supply the snapshots, history pages, live updates, and resource metadata these features consume. For HTML attachments, include the dimensions the upstream feed uses to reserve space. Keep authorization and resource access on the host. When a change affects loading, check both time to first readable text and movement after it appears. Use empty and saved phone caches and include a session with tool calls, images, and an inline render.

Apply this rule across the app, including projects, files, Git, pull requests, issues, archive, settings, browsers, and devices. Trace the active phone and tablet routes to the typed host read, write, or event. Compare that path with the upstream revision in `apps/mobile/UPSTREAM.md`. Keep the upstream state and interaction code on the client side of the adapter. This includes cache ownership and freshness, partial results from multiple hosts, paging, retries, and selection after updates. Remove parallel feature loaders and selectors when the upstream implementation can consume translated data.

Key host data and outstanding requests by their account, organization, host, and connection as applicable. Preserve host permission checks and keep signed resource URLs within their scope. Keep a Solus-specific adapter where the host owns a different operation, such as pairing, provider sign-in, or device control. Document that difference. Exercise the real entry point with cold and warm data. Check that an old reply cannot populate a new scope. Measure on comparable devices and data before claiming performance parity.
