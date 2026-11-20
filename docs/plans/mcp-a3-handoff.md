# MCP A3 handoff: full tool result content

Branch: `solus/mcp-tool-result-content`, from
`solus/merge-mcp-branches-and-build-a1-facts` (`5127e4f0e`). Nothing was
pushed. No pull request was opened.

## Commits

- `9f87f641d` feat(mcp): send full tool result content to both providers.
- `a01c2d277` feat(conversation): play tool audio and show left-out content in the tool row.
- `77c5c83b0` docs(mcp): record A3 result content and correct the plan.

## Names later phases use

- `agentResultOf(result, { tool, outputSchema?, assetsDir? })` in
  `packages/server/src/integrations/result-content.ts`: the one mapper of MCP
  content. E (prompts), F1 (resource reads), and G (MCP task results) call it.
- `outputSchemaRefusal(tool, error)`: the SDK's output schema error as the same
  error result. `mergedAccountResults(parts)`: a read across several accounts.
- `AgentToolResult.images?: AgentToolImage[]` (was `image`).
  `AgentToolImageType` is PNG, JPEG, WebP, or GIF.
- `ToolResultAudio { assetId, mimeType }`; `toolAudio` and `toolLeftOut` on
  `tool_result`, `tool_call_update`, the wire `tool_result`, `Message`, and the
  history row.
- `data/assets/tool-result-media.ts`: `audioLine`, `leftOutLine`, and
  `toolResultMedia(text)`, which reads the lines back for the person.
- `data/assets/assets.ts`: `audioAssetExtension(mime, bytes)` and
  `audioAssetMime(assetId)`. A stored audio asset plays in place.
- F1: the resource link line is
  `Resource link: <title or name> <<uri>> (<type>)`. F1 adds the sentence
  "Read it with `read_integration_resource`, server `<slug>`." when it adds
  the tool. Before F1 the line names no tool.

## What each provider's model receives

| Content | Claude | Codex |
|---|---|---|
| Text | Text block | `inputText` |
| `structuredContent` | JSON text after the text parts (not repeated when a text part is the same JSON) | The same |
| Image (PNG, JPEG, WebP, GIF; bytes checked) | One MCP image block each, in order; the CLI gives the model image blocks | One `inputImage` data URL each, in order |
| Image of another type, or past a limit | A `[Left out: …]` line; the file is saved and the line has its host path | The same |
| Audio | `[Audio: <type>, <size>, saved at <host path>]` | The same. `inputAudio` exists in the Codex protocol but is not used: Claude has no equal, and nothing shows the Codex models accept it |
| Blob resource | Image or audio as above; any other type is saved and named by path | The same |
| Resource link | One text line | The same |
| Unknown content type | A `[Left out: …]` line | The same |

The person sees every image the agent got (`toolImages`, from each provider's
own transcript), an audio player for each `toolAudio`, and the `toolLeftOut`
notes without host paths. A client never gets a tool's text, so these fields
are how the person learns what was left out.

## Limits

Images: 8 for one result, 5 MB each after the PNG scale, 10 MB together.
Saved files: 10 MB each, 8 for one result, 25 MB together. Text: 200,000
characters. A tool row shows at most 8 players and 8 notes. Each limit is
named in its `[Left out: …]` line.

## Contradictions between the plan and the code

All are corrected in `mcp-first-class.md` (§1 items 8, 19, 20; §3.1; §6; §15).

1. Codex has `inputAudio` (generated `DynamicToolCallOutputContentItem.ts`,
   Codex CLI 0.167). The plan said it had text and images only.
2. The plan put saved files in the attachment store. That store has no asset
   ids. Files go to the asset store (`writeAssetBytes`); `agentReadablePath`
   gives the agent a readable path.
3. The plan added `audio`/`AgentToolAudio` to `AgentToolResult`. The tool row
   is built from the provider's transcript, not from `AgentToolResult`, so the
   host reads the audio line back instead. No `audio` member was added.
4. The plan said the person gets "the same line". A client never receives tool
   text (`contentBytes` only), so `toolLeftOut` was added.
5. The plan said text wins without a schema and only JSON with a schema. The
   brief requires both kept; both are kept, without a repeat.
6. The version 2 SDK already validates `structuredContent` in `callTool` when
   its session listed the tool, and throws `ProtocolError`. Before A3 that
   closed the session and said "could not run". The gateway now maps it to the
   plan's error result and keeps the session; its own check covers sessions
   that did not list (another account).

## Gateway edits (A2 owns the call path)

Three small lines in `gateway.ts`: `mapCallResult` became `agentResultOf` in
`callAs`, `outputSchemaRefusal` in its `catch`, and `mergedAccountResults` in
`call`. Expect a small merge with A2's `callAs` edits. The tool card change is
in the result area of `ToolGroupItem.svelte` only.

## Tests and checks

- `tests/unit/integrations/result-content.test.ts`: 18 pass.
- `tests/unit/integrations/`: every file passes, as at the base
  (`integration-tools` has 4 fewer tests; they moved to `result-content`).
- `claude-tool-adapter`, `codex-tool-adapter`, `artifact-work`,
  `browser-snapshot-tool`: pass. `native-mobile-integrations` (1 label
  failure), `agent-tool-schema-size`, and `server-module-boundaries` fail
  exactly as at the base.
- `transcript-images.test.ts` cannot run here: anything that imports
  `codex-utils` needs `node:sqlite`, which Bun 1.3.14 lacks. It fails the same
  way at the base. The Codex round trip of A3 (all images, `toolAudio`,
  `toolLeftOut`, live and reload) is in that file and is **not run**.
- Type checks, before and after: server 130 and 130 (same text), workspace-ui
  39 and 39 (same), client-core 2 and 2, mobile 0 and 0, contracts 0.
  `svelte-check` reports nothing in the changed Svelte files.
- `oxlint` on the changed files: 33 findings before and after (complexity
  counts normalized); none in the new files. `lint:layout`: one existing
  failure in `EditorVoiceControl.svelte`, the same at the base.
  `lint:surfaces`: clean.

## Not done or not verified

- **No screenshots.** The web demo (`apps/client/demo`) does not render in dev
  mode in this checkout, at the base commit too: the page stops answering
  after load, in the Solus browser and in headless Chrome. Vite also refuses
  the worktree path, which is under `.git/`. All demo servers that this
  session started were stopped by PID, and the temporary fixture was removed.
- **Desktop, web, and mobile were not exercised interactively.** Mobile needs
  a native build; only its type check ran.
- The Claude CLI's own MCP output limit (`MAX_MCP_OUTPUT_TOKENS`) and how it
  counts images were not measured.
- No real provider turn ran; the adapters are covered by unit tests.
- A server can write an `[Audio: …]` or `[Left out: …]` line in its own text.
  A player appears only for a stored audio asset id, so it can point only at
  bytes the server already has. A forged note shows as plain text.
