# Verification and failure trace

Baseline inspected: a7065bfef8542ee8c88ca78c122f35273bf3bb74.

## startLine trace
1. VS Code provides options.tools with inputSchema.
2. convertTools forwards inputSchema as function.parameters unchanged.
3. Ollama returns function.arguments objects; LM Studio returns JSON strings.
4. Previously malformed strings became {raw: value} and missing fields passed through to LanguageModelToolCallPart.
5. VS Code subsequently validates/executes its file-reading tool and can reject missing startLine.

This explains an unguarded path, not a reproduction of the user's exact response. Fix rejects malformed/non-object arguments, unknown tools and missing top-level required parameters before emission. Ajv also checks types and nested constraints, without coercion or defaults.

## Local acceptance checklist (UNVERIFIED)
Record VS Code/Copilot, extension, server version, model ID/digest, endpoint and template. Use a disposable workspace containing a harmless ROADMAP.md fixture.
- qwen3:8b Ask with attached fixture: accurate response; outbound request has no tools.
- qwen2.5-coder:7b Ask: ordinary text works; CLI success alone says nothing about tools.
- Native Agent read: required startLine/endLine present, structured call received, result included in next turn, final answer grounded in fixture.
- Incomplete read call: bridge error names missing field; no invocation.
- JSON-in-text: display text, no invocation.
- LM Studio two-turn read: exact tool_call_id correlation and string argument history.
- Required tools rejected by server: explicit failure, no chat fallback.
- Cancel during generation and body stall: request stops within configured timeout.

Do not capture real workspace contents or API keys in committed logs. Mocked tests are reproducible protocol checks only.

## Automated result

2026-10-09: TypeScript compilation and ESLint passed; 8 mocked regression tests passed; git diff --check passed. No live-server or VS Code extension-host acceptance performed.

## Diagnostic Output channel

Run `BBA LocalLLM Bridge: Show Diagnostics` in the Extension Development Host. Each request has an ID and logs provider/model, offered/sent tool count, names/required keys, tool mode, message count, native call names, validation rejection/emission, fallback and completion counts. Prompts, file contents, response text, argument values, endpoints and credentials are omitted. Output is local to the VS Code session; copy only the relevant request lines.

User-reported 2026-10-09 live evidence: local compile/lint and 8 tests passed; qwen3:8b attached-file Ask returned BRIDGE-7429; Agent returned ordinary text with invented contents and no tool activity. Direct Ollama bridge_probe request returned native tool_calls with the correct code. Inspect Tool Support reported provider capability. Versions and actual Agent payload remain unknown; next step is tracing offered/sent tools and response part counts.

## Isolate file reading

Set `bbaLocalLlmBridge.diagnosticToolFilter` to `["read_file"]` in the test host settings. The filter intersects VS Code's offered tools by exact backend name, preserves their schemas and does not enable model capability. Empty (default) leaves tool requests unchanged; tool-free Ask stays unchanged. A nonempty filter with no usable match fails explicitly before HTTP rather than silently removing tools. Confirm sentToolCount=1 and read_file in diagnostics. Clear the setting to [] after the controlled test.

Further user evidence: 58-tool Agent request hit request timeout; longer timeout produced a native send_to_terminal call with an invalid UUID, rejected by schema validation. Subsequent 13- and 34-tool requests completed as text only. Tool-picker changes did not isolate read_file. These are observations, not proof that tool count caused the failures.

## Transport follow-up

User server logs showed generation beyond 4000 tokens, a 4096-token context shift and client disconnect after 5m2s while Ollama stayed healthy. The underlying client cause was not captured; a separate header timeout is a hypothesis. Ollama tool requests now stream NDJSON, log chunk/thinking character counts only, and limit generation to 1024 tokens by default. No calls are emitted from truncated or token-limited streams. The limit can be raised with ollama.toolMaxTokens; normal Ask has no new output cap. Context is explicitly requested via num_ctx and advertised consistently through ollama.contextTokens. Known fetch cause codes and HTTP status are logged without raw messages.

Official protocol references: https://docs.ollama.com/api/chat and https://docs.ollama.com/capabilities/tool-calling . Live acceptance of these changes remains pending.

## Live controlled acceptance (user-reported, 2026-10-10)

Ollama 0.40.2, qwen3:8b digest prefix 500a1f067a9f, context 4096, 30% CPU / 70% GPU allocation. With streaming and read_file filter: native read_file emitted after schema validation, subsequent reply returned BRIDGE-7429; follow-up after compaction returned M1 (UI showed Read activity). With filter cleared, 34 tools including read_file were sent; stream completed normally with no calls and model incorrectly claimed read_file unavailable. General Agent acceptance remains failed; single-tool path passed. Larger request truncation is a hypothesis, not a confirmed diagnosis.

New request-size events report serialized message/schema bytes and a rough characters/4 token estimate, explicitly excluding template overhead. Completion reports provider prompt_eval_count/eval_count when supplied. Provider prompt counts can describe already-truncated input and cannot alone prove absence of truncation. No automatic tool removal or context increase is performed.

## Estimated context guard

Tool-bearing Ollama requests now fail before HTTP when the characters/4 input estimate exceeds configured contextTokens, unless ollama.guardToolContext is explicitly disabled. This heuristic excludes template overhead and output reserve; passing it does not guarantee fit, and it may reject requests that could fit. Ordinary Ask is unchanged. The bridge never silently prunes tools or increases context. Error and context-budget-rejected diagnostics name counts and configuration options without content.

Latest user evidence: 34-tool request messageBytes=15295, toolSchemaBytes=59385, estimatedInputTokens=18661, configuredContextTokens=4096. Provider promptEvalTokens=2050 on two attempts: one text-only completion and one native read_file missing filePath, rejected. These counts suggest context pressure but do not alone prove truncation or its exact effect. Measure the successful one-tool request next.
