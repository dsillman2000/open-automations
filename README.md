# open-automations

Automation workflows for software projects — review, revise, and approve AI-generated changelogs with a human in the loop.

## Quick start

```bash
# Start services (Postgres + opencode serve)
open-automate setup

# Generate a changelog entry for the last 3 commits
open-automate changelog run --from HEAD~3

# Or run interactively (watch it generate, then /accept or /reject)
open-automate changelog run --from HEAD~3 --interactive
```

Workflows are stored in Postgres and survive Ctrl+C. Resume anytime:

```bash
open-automate changelog status <id>
open-automate changelog accept <id>
open-automate changelog reject <id> [feedback...]
```

Browse all workflows:

```bash
open-automate workflows list
open-automate workflows get <id>
```

## How it works

Each `run` reserves a workflow ID (`changelog/<project>/<n>`), fetches git history and repository tags, passes the context to an AI model, and stores the result. A human reviews and either accepts (writes to `CHANGELOG.md`) or rejects (with optional feedback for revision). All state is in Postgres — no daemon needed.

## Requirements

- Node.js 24+
- Docker (for Postgres 18)
- `opencode` CLI for AI provider configuration
