# Architecture

VS Code owns chat context and tool execution. LocalLlmChatProvider discovers models, converts request parts and schemas, submits to the selected backend and reports text or validated structured calls. It performs no direct tool execution.

Ollama: /api/tags lists models; /api/show reports capabilities. /api/chat uses object arguments and tool_name results. Ask uses NDJSON; tool-bearing requests use a buffered JSON response.

LM Studio: /v1/models lists models; absent capability metadata remains unknown. /v1/chat/completions uses string arguments and tool_call_id results. Ask uses SSE; tool-bearing requests use buffered JSON.

Schemas are passed unchanged. Structured tool_calls are parsed as objects, checked against the offered names and JSON Schema constraints, then emitted as LanguageModelToolCallPart. Plain content is always LanguageModelTextPart, even if it looks like a tool call. Invalid inputs fail explicitly; no raw fallback and no guessed defaults.

Capability metadata only controls tool advertisement, independently of chat discovery. Legacy visibility and allowlist settings are not evidence. Live probes and stronger schema validation remain planned.

HTTP timeout and cancellation span response body consumption. Explicit unsupported-tool HTTP 400 responses can fall back only for optional tool mode. Required mode and unrelated 400 errors fail. Token counts and context windows currently use estimates/constants and need later hardening.

Regression tests load compiled provider code with a minimal VS Code API double and fake HTTP responses. They protect schema forwarding, startLine failure, native calls, provider history and attached-file Ask. They do not establish live model capability or picker availability in a specific VS Code build.
