# Loading skeletons

All workspace clients use the same loading rule: show a skeleton while a surface waits for its code, its initial content, or its render to mount. Open a known route before waiting for its content. Keep the skeleton until the content can be used.

The route outlet covers module loading. The feature owns data loading and render readiness. Use the feature skeleton when one exists; use `ContentSkeleton` for smaller text and preview regions. Preserve known titles and pane controls during a wait. An empty manifest body does not mean a document is ready. A successfully loaded empty document is valid.

Mount a child that must emit a ready signal beneath its skeleton. Do not gate that child out of the tree: it must mount to complete the wait. HTML artifact frames keep their skeleton until the iframe load event, including after content changes and reloads. Theme changes do not reload the frame.

A failed request must show an error or the existing recovery action. It must not remain behind a skeleton. Keep usable cached content during background refresh when the feature supports it. Action progress, such as sending a message or merging a PR, is separate from content loading.

This rule applies to leading and companion panes, Editor and Pill mode surfaces, and desktop, web, and mobile clients. It does not depend on the agent provider or host transport. Skeletons use shared theme tokens and respect reduced motion.
