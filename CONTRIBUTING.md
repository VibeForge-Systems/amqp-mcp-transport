# Contributing

Thanks for helping. Bug reports, fixes, documentation and review of the draft 2.x binding are all
welcome. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security
problems privately, as [SECURITY.md](SECURITY.md) describes, never in a public issue.

## Set up

```bash
git clone https://github.com/VibeForge-Systems/amqp-mcp-transport
cd amqp-mcp-transport
npm install          # also builds dist/, via the prepare script
```

Node 22 or later. The tests need no broker: they inject a fake connection. To run the examples
against a real broker, start one with `docker compose up -d`, as the
[README](README.md#quick-start) shows.

## Before you open a pull request

Run what CI runs:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run build:examples
```

CI runs the same checks, the tests on Node 22 and 24.

## What a change needs

- **A test.** A bug fix comes with a test that fails without it.
- **Contract changes come with the contract.** [docs/TRANSPORT_CONTRACT.md](docs/TRANSPORT_CONTRACT.md)
  is normative for 1.x, and `src/transports/__tests__/contract.test.ts` pins each clause by
  number. A change to wire behaviour updates both in the same pull request.
- **Binding changes start as an issue.** [docs/BINDING.md](docs/BINDING.md) is the design 2.0.0 is
  built against. Propose a change to it in an issue before you write code for it.
- **A CHANGELOG entry** under `[Unreleased]`, for anything a user of the package would notice.
- **Strict TypeScript, and the existing ESLint config.** No new runtime dependencies without
  discussion first.

## Layout

```text
src/transports/   the 1.x client and server transports, AmqpServerRuntime and utilities
src/binding/      binding-core, exported as /binding
examples/         the client and server behind npm run example:*
docs/             the guides, the contract and the binding; docs/history/ holds dated records
```

## Pull requests

Branch from `main` and keep each pull request to one change. Say what it changes, why, and how you
tested it. By contributing, you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE).
