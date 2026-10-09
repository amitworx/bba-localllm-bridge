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
