---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Engineering rules

These rules follow portalcrew/morty's engineering standards, adapted to this repository. Read
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) and [docs/TESTING.md](docs/TESTING.md) before changing behavior.

## Trust boundary

- Treat GitHub responses, Issue comments, workflow inputs, files from previous steps, browser storage and agent
  output as untrusted. Decode as `unknown`, validate the schema, normalize targets, authorize, execute, then
  record a sanitized outcome.
- Comment authorship is never authority: every member can post as the Actions bot. Only channel authentication
  establishes who wrote a session message.
- Identity comes from authenticated GitHub responses and verified Actions context, never from a caller's claim.
- Agent processes receive only the variables they need, through sudo's environment reset. Never pass the run's
  GitHub token, the channel key, or `GITHUB_*` variables to them.
- Never log tokens, codes, links, message contents or keys. Workflow logs may be public.

## State and contracts

- Model lifecycle and protocol states as readonly discriminated unions with a `kind` tag. Handle them exhaustively
  with `default: return value satisfies never;`.
- No type assertions other than `as const`, no non-null assertions, no `any`.
- Declare ports and callbacks as readonly function properties.
- Errors crossing a boundary are `AppError`s with a stable code. Branch on codes, keep the cause, and keep
  cancellation and timeouts distinct. User-facing text lives in `src/web/view-models/copy.ts`.

## Async work

- Everything that waits on GitHub, a process or a timer accepts an `AbortSignal`. Finite operations have a deadline.
- The code that starts a process, timer, listener or lifetime ends it on every path.

## Web architecture

- `src/web/view-models`: Zustand vanilla stores own workflows, polling, validation and copy. Store factories have
  no side effects; lifetimes start and stop through explicit `open`/`close` actions. Stores never subscribe to
  each other.
- `src/web/views`: render store state and wire events. No React hooks except `useStore`.
- `src/web/components`: business-agnostic rendering. Hooks are allowed for DOM-only state.
- `src/shared` is used by both the browser and the runner and imports neither.

`pnpm lint` enforces these boundaries.

## Delivery and tests

- Start a behavior change with a failing Given-When-Then scenario at a product boundary: the complete launcher
  with visible controls, or a workflow step through the Actions simulator.
- No mocks, spies or module replacement. Use the stateful fake GitHub and the controlled agent executables.
- Time comes from the injected clock. No real sleeps.
- Write code, comments, commit messages and pull requests in English. Keep Markdown changes in separate
  documentation-only pull requests.
