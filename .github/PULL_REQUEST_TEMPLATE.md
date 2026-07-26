<!-- A PR for anything touching camera behaviour should reference an issue. -->

Closes #

## What this changes

## Verification

- [ ] `bun run test` passes
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes

**If this touches camera behaviour**, note which of these applies — the camera
accepts bad writes silently, so automated tests do not establish correctness:

- [ ] Verified against real hardware, confirmed on the camera's own screen
- [ ] Verified against `luna_mock_server` only
- [ ] Not verified on a camera — ship gated off
