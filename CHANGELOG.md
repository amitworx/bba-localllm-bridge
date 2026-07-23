# Changelog

## 0.0.3

- Added `Configure Chat Visibility` command to make model visibility in Chat easier to understand and control
- Added `bbaLocalLlmBridge.chatModelVisibility` with `balanced`, `strict`, and `all-chat-models` modes
- Improved default UX so likely chat models can appear in Chat without requiring users to manually edit tool-calling allowlists

## 0.0.2

- Fixed LM Studio chat failures for models that reject tool payloads on normal chat turns
- Added automatic retry without tool payloads when a provider returns `400 Bad Request`
- Made tool-calling opt-in by metadata or explicit allowlist instead of broad model-name heuristics

## 0.0.1

- Initial scaffold for the BBA LocalLLM Bridge VS Code extension
- Local model discovery for Ollama and LM Studio
- Chat model provider integration for the VS Code model picker
- Publishable project structure with TypeScript, linting, and packaging scripts
