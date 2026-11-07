# Documentation

`@vibeforge-systems/amqp-mcp-transport` carries MCP over AMQP 0-9.1. 1.x serves the 2025-era
protocol through `@modelcontextprotocol/sdk` v1. 2.0.0 implements MCP 2026-07-28. Start with the
[project README](../README.md).

## Using 1.x

| Document | What it covers |
| --- | --- |
| [getting-started.md](./getting-started.md) | Install, broker, server, client, recovery, timeouts, TLS, logging, custom routing |
| [api-reference.md](./api-reference.md) | Every export, every option and its default |
| [troubleshooting.md](./troubleshooting.md) | The failures that actually happen, and what each one means |

## Specifications

| Document | Status |
| --- | --- |
| [TRANSPORT_CONTRACT.md](./TRANSPORT_CONTRACT.md) | Normative for 1.x. `contract.test.ts` pins each clause. |
| [BINDING.md](./BINDING.md) | Draft binding for MCP 2026-07-28, the design 2.0.0 is built against |

## History

[history/](./history/) holds dated records. Each describes the project as it was on its date, and
none of them describes current behaviour.

| Document | Date | What it is |
| --- | --- | --- |
| [AUDIT_2026-02-15.md](./history/AUDIT_2026-02-15.md) | 2026-02-15 | Audit of 1.0.0. Its claims of compliance and production readiness were withdrawn in 1.2.0. |
| [REARCHITECTURE_PLAN_2026-07-28.md](./history/REARCHITECTURE_PLAN_2026-07-28.md) | 2026-10-22 to 2026-10-28 | The plan for 2.0.0, for MCP 2026-07-28, and its decision log. BINDING.md carries the ratified design. |
| [spike-phase2-2026-10-28/](./history/spike-phase2-2026-10-28/README.md) | 2026-10-28 | The engine-B spike against SDK 2.4.0 and RabbitMQ 4.4.0, with its scripts |
