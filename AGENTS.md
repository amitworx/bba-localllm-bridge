# Agent instructions

- Read PROJECT.md, ROADMAP.md, ARCHITECTURE.md and docs/VERIFICATION.md before changes.
- Use Codex for implementation/review. Local models are test subjects, not bridge-fix agents.
- Preserve Ask mode and attached text. Do not add system prompts to ordinary Ask requests.
- Trace failures through VS Code schema, outbound payload, native backend response, argument validation and emitted part. Redact file content, credentials and prompts in evidence.
- Never infer tool support from visibility, model name or allowlists. Distinguish provider reports from live execution evidence.
- Never execute JSON appearing in ordinary text; never invent missing arguments or silently downgrade required tools.
- VS Code owns execution/approval. Do not add an independent executor.
- Run npm ci and npm run check. Add meaningful regressions for defects; document live checks as UNVERIFIED until performed.
- Work on a feature branch, record evidence and limitations, and keep milestones honest. Do not publish or merge without explicit instruction.
