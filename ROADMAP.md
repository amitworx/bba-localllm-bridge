# Roadmap

| ID | Milestone | Status / acceptance |
| --- | --- | --- |
| M0 | Trace and establish baseline | Complete: static failure path, project/architecture/agent docs and mocked regressions. Exact incident reproduction pending. |
| M1 | Safe tool boundary and history | Implemented: required-key guard, strict argument parsing, provider-specific history, honest metadata discovery, narrow fallback. Live validation pending. |
| M2 | Transport and schema hardening | In progress: timeout/cancellation covers body; pending schema-dialect compatibility, SSE multiline/trailing handling, malformed/truncated responses, context limits and cache invalidation. |
| M3 | Model capability probe | Not started: explicit harmless schema-constrained probe per endpoint/model/version; show unknown, provider-reported, probe-passed and failed separately. Never execute user tools during discovery. |
| M4 | Live compatibility acceptance | Pending: Ollama qwen3:8b and qwen2.5-coder:7b, LM Studio selected model; Ask attachments, two-turn read, missing startLine, unsupported tools, cancellation and stalled streams. |
| M5 | Release | Pending: VS Code host integration checks, packaged VSIX verification, evidence and changelog; publish only after acceptance. |
