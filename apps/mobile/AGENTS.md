# Solus mobile

Use the T3 Code frontend. Keep its screens, navigation, layout, menus, gestures, and controls. Connect those components to the selected Solus host through its typed backend. Keep Solus branding. Ask before replacing a T3 screen or changing its interaction.

For mobile features and upstream updates, read the repository skill at `.agents/skills/solus-mobile/SKILL.md` from the Solus repository root.

Reuse T3's session navigation, list state, history controls, and conversation feed builder. Translate Solus records and events at their inputs so upstream performance fixes reach the app.

Apply the same rule to **every mobile feature**. Follow the phone and tablet routes into the upstream feature, its state, and its host operation. Keep the upstream query, cache, selectors, paging, subscriptions, and action handling wherever the host contract fits. Translate at the lowest typed operation that differs. A screen that uses the same layout but runs a second loader can still lose the upstream performance gains.

Keep Solus in charge of account and organization scope, host selection, permissions, transport, and signed resources. A reconnect or account switch must invalidate reads for the previous connection. Show controls for operations the host supports. Record intentional differences in `UPSTREAM.md`. Verify the active route and its data path, including warm reads, retries, and a scope change when applicable.
