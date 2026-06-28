# Keep a Changelog — Reference for Automation

Based on [keepachangelog.com/en/1.1.0/](https://keepachangelog.com/en/1.1.0/).

## Format

- File: `CHANGELOG.md` (uppercase, `.md` extension).
- Header: `# Changelog`
- Follow [Semantic Versioning](https://semver.org/).
- Reverse chronological order (newest version first).
- Each version links to its tag diff (reference-style links).
- Dates are ISO 8601: `YYYY-MM-DD`.

## Entry Structure

```
## [Unreleased]

## [<version>] - <YYYY-MM-DD>

### Added       — new features
### Changed     — changes to existing functionality
### Deprecated  — soon-to-be removed features
### Removed     — now removed features
### Fixed       — bug fixes
### Security    — vulnerability fixes (lead with CVE ID)

[<version>]: <compare-url>
```

## Rules

1. **Humans first** — entries are curated, not raw `git log`.
2. **One section per version** — group changes by type.
3. **Latest first** — newest release at the top.
4. **Every version has a date** — always include `YYYY-MM-DD`.
5. **Yanked releases** — mark with `[YANKED]` in the header: `## [0.0.5] - 2014-12-13 [YANKED]`
6. **Unreleased section** — keep at top for tracking upcoming changes.
7. **Breaking changes** — call them out clearly under Changed.
8. **Empty sections** — omit; don't keep empty `###` headers.
9. **Linkable** — version headers and sections should use anchor-able Markdown.
10. **Language** — plain, concise English. No git jargon.

## Bad Practices to Avoid

- **Commit log dumps** — don't paste raw `git log` output.
- **Inconsistent tracking** — missing entries erode trust.
- **Ambiguous dates** — always use `YYYY-MM-DD`.
- **Ignoring deprecations** — list them so users can migrate before removal.
