# Model prices

Insights shows what a turn's tokens cost. Claude Code reports a turn's cost itself. For Codex and Antigravity, which report only tokens, the host prices the tokens from LiteLLM's price list (`model_prices_and_context_window.json` in `BerriAI/litellm`), the list T3 Code reads too.

- **Source.** `updates/model-prices-service.ts` downloads the list when the host starts and once a day after that. It keeps only the model makers' own prices: a bare model name, or a name under `openai/`, `gemini/`, or `anthropic/`. A cloud's or a reseller's entry (`azure/`, `vertex_ai/`, …) can carry a markup, so Solus never reads it.
- **Cache.** The host writes the prices it kept to `<data>/model-prices.json` (about 100 KB). After a restart with no network, the host prices turns from that file.
- **Rates.** A rate the list leaves out is the input rate. A long-context rate (`…_above_272k_tokens`) applies when one request's input passes the threshold. The context fill at the end of a turn stands for the largest request, because a turn sums many requests (`execution/observability/model-pricing.ts`).
- **Unknown cost.** A model with no price, or a host that has not yet read a list, records no cost. It never records zero.
