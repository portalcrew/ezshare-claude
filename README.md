---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# ezshare-claude

Share one Claude Code account with your team while every member keeps a private session.

A member opens the launcher, connects with a fine-grained GitHub token and starts a session. GitHub Actions
starts a fresh runner for that member, Claude Code runs there with the team's shared account, and Morty connects
it to the member's browser. Sessions last up to four hours and end early after 15 minutes without a new Claude
turn, which frees the runner. Normal session shutdown, including an idle stop, encrypts the member's Claude
conversation and workspace for the next session, under a key kept only in that browser. An unreadable archive
is not overwritten unless the member chooses to replace it; clearing browser data loses its key. An account
owner shares their Claude account once, from the same launcher.

## How it stays private

- The browser and the session run talk through an Issue in this repository, but every message is encrypted and
  authenticated with keys that only the two of them hold. The browser's key is a `workflow_dispatch` input that
  only the member's own token can set; the run's key is the name of an artifact that only that run can upload.
  Another member who can post as the Actions bot cannot write a message the browser accepts.
- Runs are verified on both sides: the member's own first attempt of the session workflow on the default branch.
- Claude and Morty run as a separate operating-system account without sudo, so they cannot read the run's GitHub
  token or channel key.
- The launcher only accepts fine-grained tokens and stores them encrypted in the browser.

What it does not protect against is described in [SECURITY.md](SECURITY.md); read it before sharing an account.

## Using a team deployment or hosting your own

Members of an existing team use that team's launcher and execution repository; they do not each fork it.
An independent user or team forks this repository and deploys their own launcher and Actions workflows.
Forks do not inherit the shared Claude credential: an account owner must share one in the new repository.

## Setting up your fork

1. Fork into your own account for individual use, or into your organization for a team. Enable Issues and the
   fork's Actions workflows. Protect the default branch: anyone who can change it can change the code that
   receives the shared credential. Give organization members write access to the execution repository.
2. In **Settings → Pages**, select **GitHub Actions** as the source, then run **Deploy launcher** on main. The
   workflow automatically uses the current repository for the connection form and token templates. Pages metadata
   supplies the asset base path and the deployment action supplies the published URL; no source edits are needed.
   It supports both `https://<owner>.github.io/<repository>/` and a custom domain.
3. For production, configure a dedicated hostname in **Settings → Pages → Custom domain**, and make its DNS-only
   CNAME point to `<fork-owner>.github.io` without a repository path. Wait for the Pages certificate and enable
   **Enforce HTTPS**. The domain is configured once in Pages, not duplicated in an environment variable.
   The current upstream deployment is https://ezshare-claude.connect-screen.com; forks do not inherit that domain.
4. Treat the whole browser origin as trusted. Paths under one `<owner>.github.io` share browser storage and
   encryption keys with every other Pages site on that host. A repository path is not an isolation boundary.
   Only connect with a real token when all sites on that host are trusted, or use a dedicated custom hostname.
   Changing the hostname later changes the origin and does not migrate browser history keys automatically.
5. The account owner opens **Share your account** in the fork's launcher. A member's fine-grained token selects
   only the fork and needs Actions/Issues read and write; the owner's token additionally needs Secrets read and
   write. Organization policies may require approval. This launcher accepts fine-grained tokens only; GitHub's
   repository/outside-collaborator limitations make an organization with internal members the supported team setup.
   See [GitHub's token limitations](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations).

The deployment builds and publishes `dist/web` on main pushes or manually. Its public build inputs are
`VITE_DEFAULT_REPOSITORY` (from `github.repository`) and `PAGES_BASE_PATH` (from the Pages action). A local build
can set them explicitly; with no repository configured, the connection form starts empty. These are public
configuration values, never places for tokens or keys.

No Cloudflare deployment credential is required. The build embeds the CSP from `vite.config.ts`; `_headers`
files do not configure GitHub Pages. When migrating a hostname from a Worker, prepare Pages first, remove only
that hostname's Worker binding, and set the CNAME above. Keep the Worker itself for rollback. Wrangler OAuth can
manage the Worker binding but not DNS records; command-line DNS migration additionally needs a zone-scoped DNS
Edit token. Never put that token in source, logs, or chat.

The repository may be public. Session contents are encrypted, but anyone can see when sessions start and end.

## Development

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md), [docs/TESTING.md](docs/TESTING.md) and [AGENTS.md](AGENTS.md).
