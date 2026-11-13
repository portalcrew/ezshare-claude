---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Testing

```sh
pnpm test
```

Scenarios render the complete launcher in happy-dom and act through visible controls. GitHub is a stateful fake
reached through the production HTTP client. Dispatched workflows run in an Actions simulator that follows the
workflow files: it prepares the channel key, publishes the artifact and runs the production session step
in-process. Claude Code, Morty and sudo are controlled executables at their process boundaries; the fake sudo
resets the environment like the real one, so a leaked variable fails the scenario.

The simulator does not establish compatibility with the real Claude Code or Morty CLIs, the real sudo policy of
GitHub's runners, or GitHub's artifact permissions. Verify those on a real repository before a release and
record the result in the pull request.
