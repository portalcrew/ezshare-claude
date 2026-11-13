---
metadata:
  change-policy: >-
    Submit Markdown changes in a separate documentation-only pull request.
---

# Security policy

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/portalcrew/ezshare-claude/security/advisories/new)
to report a security issue in this repository's code or workflows.

Include the affected revision or version, reproduction steps, expected and actual
behavior, and the potential impact. Use synthetic examples instead of live
credentials or other people's private data.

Please keep vulnerability details out of public issues and pull requests until
the maintainers have investigated the report and coordinated disclosure with you.
Test only systems and accounts you control.

## Trust model

- **The default branch is trusted.** Session workflows run its code with the shared token. Anyone who can push
  to it, or merge into it, can read every future session. Protect it.
- **Members with write access are trusted with the shared account.** Inside their own session, a member can read
  the shared token from the environment and keep using it elsewhere until the owner revokes it. Sharing an account
  means giving it to every member.
- **Members are not trusted with each other's sessions.** A member cannot read or redirect another member's
  session: channel messages are authenticated with keys bound through the member's own dispatch and the run's own
  artifact, both runs verify each other's identity, and agents run as an account that cannot reach the run's
  GitHub token.
- **GitHub and the runner VM are trusted.** So is Morty's relay, which carries the chat traffic.

In scope: any path that lets one member read, control or impersonate another member's session, obtain the
shared token without write access, or obtain a member's GitHub token.

Out of scope: a member with write access using the shared account they were given, and anything that requires
pushing to the protected default branch.

## Residual risks

- The launcher keeps the GitHub token encrypted with a key stored next to it. That protects copies of the browser
  profile, not script running on the launcher's origin, which is why the launcher must have an origin of its own.
- The agent tools are installed from a lockfile with integrity hashes, but Claude Code's own install script
  downloads platform binaries outside that lockfile.
- In a public repository, session start and end times and the members' GitHub identities are public.
