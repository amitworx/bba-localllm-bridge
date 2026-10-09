# BBA LocalLLM Bridge

Expose local models from Ollama or LM Studio in the VS Code chat model picker.

## What this extension does

This extension registers a `LanguageModelChatProvider` named **BBA LocalLLM Bridge**. When VS Code asks the provider for available models, it:

- discovers models from `Ollama` via `/api/tags`
- discovers models from `LM Studio` via `/v1/models`
- publishes those models into the chat model picker
- forwards chat requests to the selected local model with streaming responses

## Current scope

This is a focused bridge for chat models, not a full assistant stack. It currently:

- supports local text chat streaming
- discovers models automatically
- supports tool-calling passthrough for tool-capable models
- lets you restrict which models appear with settings
- uses naive token counting for VS Code budgeting
- includes a packaging-ready TypeScript extension scaffold

It does not yet:

- support images
- estimate tokens with model-specific tokenizers
- expose embeddings, completions, or rerank endpoints

## Extension settings

Open Settings and search for `BBA LocalLLM Bridge`.

Important settings:

- `bbaLocalLlmBridge.chatModelVisibility`
- `bbaLocalLlmBridge.ollama.baseUrl`
- `bbaLocalLlmBridge.ollama.models`
- `bbaLocalLlmBridge.ollama.toolCallingModels`
- `bbaLocalLlmBridge.lmStudio.baseUrl`
- `bbaLocalLlmBridge.lmStudio.apiKey`
- `bbaLocalLlmBridge.lmStudio.models`
- `bbaLocalLlmBridge.lmStudio.toolCallingModels`

## Quick Start

### For most users

1. Start Ollama or the LM Studio local server.
2. Open VS Code.
3. Open the Command Palette.
4. Run `BBA LocalLLM Bridge: Configure Chat Visibility`.
5. Choose `Balanced (Recommended)`.
6. Run `BBA LocalLLM Bridge: Refresh Models`.
7. Open Chat and pick a model from **BBA LocalLLM Bridge**.

`Balanced` is the recommended mode for most users because it helps local chat models appear in Chat while safely retrying normal chat requests without tools if a backend rejects tool-enabled payloads.

## If Models Appear In Model Manager But Not In Chat

This usually means VS Code is filtering models based on the current chat mode or tool requirements.

Try this:

1. Run `BBA LocalLLM Bridge: Configure Chat Visibility`.
2. Choose `Balanced (Recommended)`.
3. Run `BBA LocalLLM Bridge: Refresh Models`.
4. Re-open the Chat model picker.
5. If needed, reload VS Code.

Visibility preferences do not enable tool calling.

## Tool Calling

Ollama capability metadata comes from `/api/show`. LM Studio uses capability metadata when supplied by `/v1/models`; absent metadata remains unknown. Provider reports are not live verification. Visibility and legacy tool allowlists never establish tool support.

Ask requests without tools retain text streaming and attached text. Native structured tool calls are validated against the offered JSON schemas before reaching VS Code. JSON printed as ordinary content remains text. The bridge never invents `startLine` or other missing arguments.

LM Studio histories preserve `tool_call_id` and JSON-string arguments; Ollama histories use object arguments and tool names. Required-tool requests never silently retry as chat. Optional tool requests fall back only on explicit unsupported-tool HTTP 400 errors.

## Troubleshooting

Run **Inspect Tool Support** and **Refresh Models** after server/model changes. If a call fails validation, record the tool name/schema and redacted argument shape. A CLI answer does not verify native tool calling. See [verification](docs/VERIFICATION.md) for the live test matrix and current limits.

## Project structure

- `src/extension.ts` contains the provider implementation
- `images/icon.png` is the marketplace-safe extension icon
- `tsconfig.json` compiles to `out/`
- `.vscode/launch.json` and `.vscode/tasks.json` support `F5` debugging

## Typical local setup

### Ollama

1. Start Ollama.
2. Ensure `http://127.0.0.1:11434/api/tags` works locally.
3. Open VS Code chat and manage models.
4. Select a model from **BBA LocalLLM Bridge**.

### LM Studio

1. Start LM Studio local server.
2. Ensure `http://127.0.0.1:1234/v1/models` works locally.
3. Open VS Code chat and manage models.
4. Select a model from **BBA LocalLLM Bridge**.

## Commands

- `BBA LocalLLM Bridge: Manage Provider`
- `BBA LocalLLM Bridge: Refresh Models`

## Development

1. Run `npm install`
2. Open this folder in VS Code
3. Press `F5` to launch the Extension Development Host
4. Open Chat and use the model picker

Useful commands:

- `npm run compile`
- `npm run lint`
- `npm run package`

## Notes

The provider API used here is documented by VS Code:

- [Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [AI language models in VS Code](https://code.visualstudio.com/docs/agent-customization/language-models)
