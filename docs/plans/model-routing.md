# Model routing

Auto is a one-time choice above Agent in the new-session model picker. On the first prompt,
the execution host asks Jev to choose one category: user interface, general use,
open-ended exploration, or well-defined task. Interface work takes priority over
the structured category when both describe the prompt. General covers unclear
requests and requests outside the other categories.

Settings → Model routing stores one Claude model, one Codex model, and a preferred
provider for each category. These settings belong to the selected host and are
shared by desktop, web, and mobile clients. Restore defaults resets all routes.

| Category | Preferred provider | Claude default | Codex default |
| --- | --- | --- | --- |
| User interface | Claude | Opus 5 | GPT 6 Astra |
| General use | Codex | Sonnet 5 | GPT 5.6 Sol |
| Open-ended exploration | Claude | Opus 5 | GPT 6 Astra |
| Well-defined task | Codex | Sonnet 5 | GPT 5.6 Terra |

The host uses the other provider if the preferred provider is not installed or
the turn's author has no seat for it. OpenCode does not participate in Auto.
Explicit model selection remains available through the existing picker.

Jev receives the first prompt text, capped at 30,000 characters, using the host's
TypeSafe key. Image contents and subsequent turns are not sent for classification.
There are no retries. A three-second deadline, missing key, or service error uses
the configured General use route. If category models have been removed, the host
also uses General use. If those models are unavailable, it uses an available
provider's default. With no eligible provider, the prompt fails with a connection
message. Stop cancels classification without starting a fallback run.

The host resolves Auto before it creates the provider conversation. It publishes
a typed `model_routed` session event with the provider and complete model config.
The client updates the existing session fields in place, so the picker shows the
selected model before agent output begins. Auto has no provider logo or reasoning label, and keeps its action above Agent.
The chosen model uses Medium reasoning and its default context window; fast mode
is off. The picker keeps models on the left and reasoning on the right while Auto is
selected. Only Auto is checked; reasoning is inactive until a manual model is
previewed or selected. The collapsed Auto chip has no reasoning label. The normal session index
persists the provider and model. Later turns continue with that model and do not
call Jev. Auto is unavailable for existing conversations and forks.

The existing prompt RPC, session event transport, and host config RPC serve local
IPC and remote WebSocket clients. No separate client-side classifier or provider
credential is required.
