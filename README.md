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
it to the member's browser. Sessions last up to one hour and keep nothing afterwards. An account owner shares
their Claude account once, from the same launcher.

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

## Setting up a team repository

1. Protect the default branch and require reviews. Anyone who can change the default branch can change the code
   that receives the shared token.
2. Give members write access, so they can dispatch workflows and create Issues.
3. The launcher is served at https://ezshare-claude.connect-screen.com, a static-assets Cloudflare Worker on an
   origin of its own: the GitHub tokens members store in the browser are readable by any script on the same
   origin, so it must never share one with other sites. Deploy it with `pnpm run deploy` (after `wrangler login`)
   or the **Deploy launcher** workflow, which needs a `CLOUDFLARE_API_TOKEN` secret limited to Workers and the
   `CLOUDFLARE_ACCOUNT_ID` variable. Security headers are defined in `src/web/public/_headers`.
4. The account owner opens **Share your account** in the launcher. Their token additionally needs Secrets read
   and write.

The repository may be public. Session contents are encrypted, but anyone can see when sessions start and end.

## Development

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md), [docs/TESTING.md](docs/TESTING.md) and [AGENTS.md](AGENTS.md).
