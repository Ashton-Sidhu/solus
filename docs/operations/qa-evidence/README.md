# QA workflow review evidence

- `focus-before.png`: initial QA rollout on 2026-09-07, before the draft focus correction. The replacement composer is not focused.
- `focus-after.png`: passing desktop focus assertion after rebasing onto main `bd7684dc`, recorded 2026-09-10. The broader appearance differs because main also changed.
- `focus-and-responsive-flow.webm`: the same passing smoke journey, including sending the first prompt, typing a draft, and changing to phone width and back.

The recordings use synthetic provider responses and an owned disposable project. They show appearance and interaction; the assertions and test result supply the behavioral proof. The recorded app source fingerprint is `62ed21307af6171b11d4e2f9848e8b066e06ffa1b080d595d8eff13a8e393bc5`.
