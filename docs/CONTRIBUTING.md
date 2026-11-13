---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Contributing

Install the Node version in `.nvmrc`, then:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev        # the launcher on http://127.0.0.1:4173
pnpm ci:check   # everything CI runs
```

Before proposing a change, run `pnpm typecheck`, `pnpm lint` and the related tests. Format pull request titles
as Conventional Commits, describe the problem, the change, the verification you ran and any compatibility
consequences. Follow [AGENTS.md](../AGENTS.md).

## Compatibility

Launchers already open in browsers, sessions in flight and the workflows on the default branch upgrade
independently. A change to the dispatch inputs, the channel envelope, message kinds or the artifact name must
keep working with the other side's previous version, or be explicitly authorized as a breaking change.
