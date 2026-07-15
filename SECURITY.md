# Security Policy

## Supported versions

Only the latest published release is supported. Fixes land on the newest version on npm.

## Scope and threat model

This library does not read, store, or transmit AWS credentials itself. It spawns the official `kiro-cli`, which owns the AWS IAM Identity Center (SSO) token and caches it under the user's home directory (`~/.aws/sso/cache`). Prompts are relayed to that local `kiro-cli` process over the Agent Client Protocol (ACP).

When the IPC / MCP bridge is used, the library runs a small HTTP server bound to loopback (`127.0.0.1`) on an ephemeral port, guarded by a per-session secret. It is not exposed to the network.

Out of scope:

| Area | Where to report |
| ---- | --------------- |
| Bugs in `kiro-cli` or the Kiro service | Amazon Web Services |
| How the Kiro service handles your data | Governed by AWS policy |
| Misconfiguration in the consuming application | The consumer, not this library |

## Reporting a vulnerability

Please report security issues privately through GitHub. Open the repo's **Security** tab and choose **Report a vulnerability** to file a private advisory.

Do not open a public issue for security problems.

Include what you found, affected version, and steps to reproduce if you have them.

## AI-generated reports

Low-effort or obviously AI-generated security reports may be closed without a response. Please only open a report you have understood and verified yourself.

## What to expect

This is a single-maintainer project, so responses are best effort. Expect an initial acknowledgement within about 7 days. Fixes for confirmed issues ship as a new npm release and are disclosed once a patch is available.
