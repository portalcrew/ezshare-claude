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

## Deployment configuration

A fork's Pages deployment injects `VITE_DEFAULT_REPOSITORY` from its own `github.repository` and derives
`PAGES_BASE_PATH` from `actions/configure-pages`. Set custom domains in repository Pages settings; the workflow
reads that existing configuration and uses `actions/deploy-pages`'s URL. Keep credentials out of both build
variables. To prefill a repository during local development:

```sh
VITE_DEFAULT_REPOSITORY=your-org/your-repository pnpm dev
```

A default project Pages URL shares its origin with the owner's other Pages sites. Use a dedicated hostname for
isolation from those sites, or trust every site on the shared host before entering a GitHub token. New hostnames
have separate browser vaults and do not automatically recover another origin's history keys.
