# Vendored A2A specification

`a2a.proto` in this directory is a **verbatim copy** of the normative A2A
definition, vendored so that conformance tests run hermetically — no network
access in CI, and no dependency on the specification site's moving `/latest`
page.

| | |
|---|---|
| Source repository | https://github.com/a2aproject/A2A |
| Tag | `v1.0.1` |
| Commit | `3303592588e388e62e0f69f701af531d2f4e3991` |
| Path in source | `specification/a2a.proto` |
| License | Apache-2.0 (see the source repository) |
| Retrieved | 2026-09-17 |

Verify the copy is unmodified with:

    shasum -a 256 packages/protocol/spec/a2a.proto

## Why a commit and not the site

`docs/PROTOCOL.md` previously pinned no revision at all, which made every claim
about A2A wire shapes unverifiable. A URL like `a2a-protocol.org/latest` is
worse than no pin, because it silently changes meaning. `v1.0.1` is a patch of
the 1.0 line and is pinned by commit, so "conformant with A2A 1.0" is a
falsifiable statement.

## How it is used

`packages/protocol/test/a2a-conformance.test.ts` parses this file, derives the
JSON field names of each message (proto snake_case to the JSON binding's
lowerCamelCase), and asserts our TypeScript interfaces carry exactly those
keys. That makes the _external_ file the contract, rather than our own types
asserting themselves — the failure mode that let an earlier milestone ship a
wire format no peer could read while its tests passed.

## Updating

Replace the file, update this table and the constants in
`packages/protocol/src/constants.ts`, then run the conformance test. A revision
bump is a protocol change and belongs in `docs/PROTOCOL.md`.
