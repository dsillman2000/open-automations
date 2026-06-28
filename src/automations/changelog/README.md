# Changelog Automation

Generates single-release changelog entries from a git commit range using an AI agent, with human review before writing.

## Commands

```
open-automate changelog run --from <ref> [--to <ref>] [--interactive]
open-automate changelog status <id>
open-automate changelog accept <id>
open-automate changelog reject <id> [feedback...]
```

## Workflow

1. **`run`** — reserves a workflow ID (`changelog/<project>/<n>`), fetches commits and tags, and generates an entry via the AI model. In detached mode (default), the generation runs in a background worker. With `--interactive`, it runs in the foreground and drops to a `>` prompt.

2. **Review** — the output includes the proposed markdown entry and its insertion point in the existing `CHANGELOG.md`.

3. **`accept <id>`** — writes the entry into the file at the determined anchor point.

4. **`reject <id>`** — discards the entry. With feedback (`reject <id> Please separate entries by type`), the workflow is re-spawned with the previous draft and feedback as revision context.

## ID resolution

Workflow IDs are shorthand-friendly: `1` resolves to `changelog/<current-dir>/1`, `swimmer/2` to `changelog/swimmer/2`, and full IDs pass through.

## Tags and versioning

Real repository tags are fetched via `git fetch --tags` and passed to the AI. The agent is instructed never to hallucinate version numbers — if no tags exist, full commit hashes are used as references with direct commit links.

## Storage

Workflow state lives in `dbos.automation_workflows` and `dbos.automation_sequences` tables in the `open_automations_dbos_sys` Postgres database. No files are written except on `accept`.
