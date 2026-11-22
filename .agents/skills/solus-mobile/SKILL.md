---
name: solus-mobile
description: Connect T3 Code mobile features to the Solus host, or update the mobile fork while preserving its upstream interface.
---

Start with the T3 screen and its normal entry points in `apps/mobile/src/features`. Keep the T3 frontend, including navigation, layout, controls, gestures, and visual states. Connect its data and commands to the selected Solus host through the typed RPC API and the mobile stores. Reuse the same screen for phone and tablet entry points where upstream does so.

Read `vendor/t3code/UPSTREAM.md` before a sync. Use the recorded fork revision to compare the changed frontend with T3. Keep Solus branding and existing product decisions. Ask before substituting a different screen or changing a user interaction. Verify both the upstream interaction and the Solus data that drives it.
