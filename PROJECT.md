# BBA LocalLLM Bridge

## Goal
Reliable VS Code language-model provider for local Ollama and LM Studio chat, with native structured tool calling where the model/server supports it. Codex implements and reviews bridge changes; local models are systems under test.

## Scope
Discover models, preserve Ask text and attached-file context, adapt provider messages and tool schemas, return structured calls to VS Code, preserve tool-result correlation, and report failures accurately. VS Code owns tool execution, permissions and Agent orchestration. The extension does not execute file or shell tools itself.

## Acceptance
- Ask works without tools on both transports, including attached text.
- Tool schema required fields reach the backend unchanged. Missing arguments are rejected before executable response parts are reported; never invent startLine.
- LM Studio uses JSON-string function arguments and tool_call_id on results; Ollama uses object arguments and tool_name.
- Plain text resembling tool JSON is never executed.
- Visibility, model names and allowlists do not prove tool capability. Provider metadata is a report, not a successful execution test.
- Required tool requests never silently downgrade to chat. Optional fallback is restricted to explicit unsupported-tool errors.

## Observations and limitations
User observed qwen2.5-coder:7b answering through CLI but printing tool JSON in VS Code; qwen3:8b Ask with attached files works; Agent read failed missing startLine. Exact failing payload/server versions are unavailable. Static tracing confirms schemas are forwarded intact, but previous response handling passed incomplete inputs through without validation. The original incident cannot yet be attributed to a specific model output or schema mismatch.

Automated mocked checks are not live acceptance. No local Ollama/LM Studio or VS Code host is available here. Current validation checks argument objects, offered tool names and JSON Schema constraints; JSON Schema validation uses Ajv without coercion/defaults.
