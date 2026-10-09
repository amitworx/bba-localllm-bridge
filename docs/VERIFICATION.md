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
