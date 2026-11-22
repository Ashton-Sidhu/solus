---
name: solus-mobile
description: Connect T3 Code mobile features to the Solus host, or import upstream updates while preserving the T3 interface.
---

Start with the T3 screen and its normal entry points in `apps/mobile/src/features`. Keep the T3 frontend, including navigation, layout, controls, gestures, and visual states. Connect its data and commands to the selected Solus host through the typed RPC API and the mobile stores. Reuse the same screen for phone and tablet entry points where upstream does so.

Read `apps/mobile/UPSTREAM.md` before an upstream update. Compare the new T3 revision with the previous import. Keep Solus branding and existing product decisions. Ask before substituting a different screen or changing a user interaction. Verify both the upstream interaction and the Solus data that drives it.
