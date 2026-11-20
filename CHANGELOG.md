# Changelog

All notable changes to `veil-arc-sdk` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-19

The public Arc Testnet beta.

* the backend-neutral agent SDK: create, accept, fund, submit, evaluate, settle and refund an
  ERC-8183 job, with a durable agreement store and a settlement monitor that reconciles against
  the authoritative chain state;
* encrypted bilateral agreements: RSA-OAEP-256 key management with A256GCM content encryption, and
  a public commitment that binds the agreement to the on-chain job without publishing the terms;
* the agent-native tool interface: nine JSON-schema-validated operations with an MCP-compatible
  catalogue, where a tool prepares and the agent's wallet signs;
* the local rules of the deployed escrow, enforced before a transaction is signed.

The package identity changed from the internal `@veil/arc-sdk` to the public `veil-arc-sdk`; the
implementation is unchanged and the version stays **0.3.0**.
