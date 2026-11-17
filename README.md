---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# ezshare-claude

Share Claude Code accounts with your team while every member keeps a private session.

A member opens the launcher, connects with a fine-grained GitHub token and starts a session. GitHub Actions
starts a fresh runner for that member. Claude Code uses the account the member selected, and the session opens
through Morty or VS Code. Sessions last up to four hours and end early after 15 minutes without a new Claude
turn, which frees the runner. The runner encrypts and uploads the member's Claude conversation and workspace
after startup, after each five-minute interval, and during normal shutdown, including an idle stop. The key is
kept only in that browser. An unreadable archive
is not overwritten unless the member chooses to replace it; clearing browser data loses its key. An account
owner adds or reauthorizes shared Claude accounts from the same launcher.

Morty normally reuses the archived Computer identity. If setup reports exactly `computer_revoked`, the runner
clears only its dedicated Morty directory and retries once with a new identity, retaining the Claude session
and workspace. The previous Computer's links no longer work. Other authorization or pairing failures are not
treated as permission to replace an identity. Actions logs record the allowlisted recovery reason and stage;
local acceptance tests cover history continuation and the single-recovery limit.

## Automatic history saves

A ready Morty or VS Code session uploads encrypted snapshots independently of launcher polling. Saves are serial:
a failed upload leaves the last completed remote snapshot available and the next interval retries. Only the
latest two snapshots from the current run are retained; a previous snapshot is removed only after its successor
uploads successfully. The normal final cache entry remains compatible with older launchers and workflows.

On normal shutdown, the runner cancels and joins any active snapshot, stops the agent, encrypts its final state
and waits for that upload before reporting that history is saved. The workflow's final cache action is a fallback
if the controller upload fails. A force-cancelled or lost runner can recover only up to its last successful
upload; changes after that snapshot may be lost. GitHub cache retention and availability still apply. Running
files can change during a snapshot, so this is best-effort recovery, not a filesystem transaction.

The archive encryption, repository/member binding and browser history key are unchanged. A browser that cannot
open the restored archive does not create checkpoints or replace it unless the member explicitly chooses to.
Existing runners do not gain this behavior until the member starts a new session.

| State or file | Writer | Reader |
| --- | --- | --- |
| Runner `ezshare-history/history.bin.partial` | Trusted controller streaming the agent's tar output through AES-GCM | Controller only; removed on failure or cancellation |
| Runner `ezshare-history/history.bin` | Controller replaces it atomically after encryption completes | Bounded cache upload worker; final workflow cache action |
| GitHub cache `ezshare-history-<user-id>-run-<run-id>-checkpoint-<uuid>` | Trusted controller through the Actions cache runtime | Next run's cache restore; contents open only with that member's browser key |
| `ACTIONS_RUNTIME_TOKEN` and cache service endpoints | GitHub's JavaScript action runtime | Trusted controller and bounded cache worker; never the unprivileged agent |
| Public `history.checkpoint` diagnostic | Controller after a save, failure, or cleanup failure | Run logs; only sequence, outcome and allowlisted error code |

Snapshot scheduling, upload failures, retention and crash recovery are covered by controlled-clock application
scenarios with real archive encryption and a stateful Actions simulator. The manual **History checkpoint cache
probe** uses synthetic bytes and an isolated cache version to check the real upload/restore/delete transport;
it does not read shared Claude credentials or personal history.

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
Forks do not inherit shared Claude credentials: an account owner must add accounts in the new repository.

## Shared accounts

**Manage shared accounts** lists stored accounts and their last credential update time. A stored credential does
not prove Claude still accepts it; Claude checks authorization when a session starts. An empty repository shows
**No accounts shared yet**. A permissions or network error is shown separately and is never treated as an empty
inventory.

- **Add account** creates an independent credential without replacing existing accounts. A label is normalized
  and limited to 36 UTF-8 bytes to fit GitHub's Secret name limit. Labels are supplied by the owner, not verified
  Claude account identities.
- **Reauthorize** replaces only the selected account's credential and keeps its identifier.
- **Remove** asks for confirmation and removes that repository Secret. Existing sessions and copied credentials
  may continue to work; revoke the token in Claude account settings to invalidate those copies. Removing an
  account never deletes members' conversation history.

The original `EZSHARE_CLAUDE_TOKEN` appears as **Previously shared account** automatically; no migration or new
Claude login is required to keep using it. Under **Use a shared account**, one available account is selected
initially. With multiple accounts, the member explicitly chooses one before starting. An account removed after
selection is not silently replaced by another. Account and interface changes keep the same personal history key
for that GitHub repository and numeric user ID.

### Credential and selection state

| State | Writer | Reader |
| --- | --- | --- |
| Original repository Secret `EZSHARE_CLAUDE_TOKEN` | Owner browser through the sealed Secrets API | GitHub's workflow caller, then the selected worker |
| Named repository Secrets `EZSHARE_CLAUDE_ACCOUNT_<id>` | Owner browser through the sealed Secrets API | GitHub's workflow caller, then the selected worker |
| Secret names and update times | GitHub when a credential is stored or changed | Members with Secrets read; API responses never include credential values |
| Current page session request (memory only) | Launcher before dispatch; released when the task ends or the page closes | Launcher while polling the task, displaying its account, or storing the returned authorization in that account's Secret |
| Runner `EZSHARE_CLAUDE_TOKEN` environment value | GitHub injects the one explicitly forwarded `claude_token` secret | Trusted session controller; only the selected Claude credential is passed to the unprivileged agent |

Account identifiers contain a reversible Base32 label and a random suffix. Labels are metadata, not encrypted
identity claims. The dispatch workflow allocates no runner and forwards one named credential to the reusable
worker; it does not inherit the repository's Secrets context. The selected account and channel key stay on the
current page's task object. There are no browser `account:` or `pending:` writes, versioned pending-record
readers, or task restoration after a page reload. Keep the launcher open through authorization or until you
save and end a chat. Switching between launcher tabs preserves the current task. A new page can see and end a
blocking run but cannot recover its private entry. Existing transient records are ignored. The encrypted
GitHub connection, personal history key, interface preference, and saved history archive formats are unchanged.

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
5. The account owner opens **Manage shared accounts → Add account** in the fork's launcher, gives it a short
   team-visible label and completes Claude authorization. The owner can use the current browser or the runner
   through desktop VS Code's Integrated Browser. A member's fine-grained token selects only the fork and needs
   Actions/Issues read and write plus Secrets read to list account metadata. Adding, reauthorizing or removing an
   account requires Secrets read and write. Organization policies may require approval. This launcher accepts fine-grained tokens only; GitHub's
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
