# AMQP MCP Transport

**Model Context Protocol over a message broker: client and server transports for AMQP 0-9.1 (RabbitMQ) that plug into the MCP TypeScript SDK, and the binding that takes them to MCP 2026-07-28.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](package.json)
[![Version](https://img.shields.io/badge/version-1.3.0-blue.svg)](CHANGELOG.md)
[![MCP SDK](https://img.shields.io/badge/%40modelcontextprotocol%2Fsdk-%3E%3D1.17.1_%3C2-6f42c1.svg)](package.json)

`@vibeforge-systems/amqp-mcp-transport` lets an MCP client and an MCP server talk through RabbitMQ
instead of over a direct HTTP or stdio connection. Hand `AMQPServerTransport` to an `McpServer` and
`AMQPClientTransport` to a `Client`, and the SDK does the rest. Every message stays a plain JSON-RPC
2.0 object on the wire. Routing and correlation live in AMQP message properties.

> **1.3.0 serves the 2025-era protocol** through `@modelcontextprotocol/sdk` v1.
> [MCP Open Discovery](https://github.com/VibeForge-Systems/mcp-open-discovery) uses it
> as its AMQP transport. **2.0.0 implements MCP 2026-07-28 and targets Q4 2026.** Its wire format
> is specified in [docs/BINDING.md](docs/BINDING.md). Its first piece, binding-core, ships in
> 1.3.0 as `@vibeforge-systems/amqp-mcp-transport/binding`.

---

## Why a broker

- **The server opens no port.** Server and client both dial out to the broker. An MCP server can
  sit in a network that accepts no inbound connections and still be reachable.
- **Clients address an exchange, not a host.** A server can restart or move without its clients
  being reconfigured. The transport reconnects on its own, and `AmqpServerRuntime` rebuilds the
  server after an outage.
- **It runs on messaging you already operate.** Authentication, TLS (`amqps://`), virtual hosts,
  per-user permissions and monitoring are the broker's, not one more HTTP endpoint per server.
- **A path to pools.** 2.0.0 serves a logical server from competing consumers on one shared queue,
  so any instance can answer any request. 1.x serves one server per exchange.

The cost is a broker to run and an extra network hop. 1.x also has limits that HTTP does not: see
[What 1.x does not do](#what-1x-does-not-do).

---

## Quick start

You need Node 18 or later and Docker.

```bash
git clone https://github.com/VibeForge-Systems/amqp-mcp-transport
cd amqp-mcp-transport
npm install                  # also builds the package, via the prepare script
docker compose up -d         # RabbitMQ on localhost:5672, user admin, password admin123
export AMQP_URL=amqp://admin:admin123@localhost:5672

npm run example:server       # terminal 1
npm run example:client       # terminal 2, with the same AMQP_URL
```

The client lists the example server's tools, resources and prompts, calls a tool and reads a
resource, all through the broker. The RabbitMQ management UI is at <http://localhost:15672>.

---

## Install

```bash
npm install @vibeforge-systems/amqp-mcp-transport @modelcontextprotocol/sdk
```

- **1.3.0 is the first release on npm.** To track unreleased work, install `main` from GitHub:
  `npm install github:VibeForge-Systems/amqp-mcp-transport`. The `prepare` script builds it on
  install.
- **v1.2.0 and earlier are named `amqp-mcp-transport`.** None of them was published to npm. The
  v1.2.0 tarball is attached to its
  [GitHub release](https://github.com/VibeForge-Systems/amqp-mcp-transport/releases/tag/v1.2.0).
  The wire format did not change with the name.
- **The SDK is a peer dependency** (`>=1.17.1 <2`), so the transport shares your application's SDK
  instance. `amqplib` is a regular dependency and installs with the package.
- **The package is ESM.** CommonJS code on Node 20.19 or later, or 22.12 or later, can
  `require()` it.

---

## Use it

### Server

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AMQPServerTransport } from "@vibeforge-systems/amqp-mcp-transport";
import { z } from "zod";

const server = new McpServer({ name: "echo-server", version: "1.0.0" });

server.registerTool(
  "echo",
  { description: "Echo the input back", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);

const transport = new AMQPServerTransport({
  amqpUrl: process.env.AMQP_URL ?? "amqp://admin:admin123@localhost:5672",
  exchangeName: "mcp.examples",
  queuePrefix: "mcp.example",
});

await server.connect(transport); // the SDK calls transport.start()
```

### Client

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AMQPClientTransport } from "@vibeforge-systems/amqp-mcp-transport";

const transport = new AMQPClientTransport({
  amqpUrl: process.env.AMQP_URL ?? "amqp://admin:admin123@localhost:5672",
  exchangeName: "mcp.examples",       // must match the server's
  serverQueuePrefix: "mcp.example",
});

const client = new Client({ name: "echo-client", version: "1.0.0" });
await client.connect(transport);

const result = await client.callTool({ name: "echo", arguments: { text: "hello over AMQP" } });
console.log(result.content); // [ { type: 'text', text: 'hello over AMQP' } ]

await client.close();
```

Client and server find each other through `exchangeName` alone. `serverQueuePrefix` is required,
but 1.x does not use it for routing.

### Keep a server up across broker outages

The transport reconnects by itself and keeps its queue name. By default it tries every 5 seconds,
up to 10 times. If every attempt fails, it closes for good. `AmqpServerRuntime` handles that case.
It builds a new transport, attaches a new server from your factory, and retries with exponential
backoff: 30 seconds at first, growing to at most 5 minutes, with no retry limit by default.

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AmqpServerRuntime } from "@vibeforge-systems/amqp-mcp-transport";

function buildServer(): McpServer {
  const server = new McpServer({ name: "echo-server", version: "1.0.0" });
  // register tools, resources and prompts here
  return server;
}

const runtime = new AmqpServerRuntime<McpServer>();

const result = await runtime.start(
  { create: async () => buildServer() },
  {
    enabled: true,
    url: process.env.AMQP_URL ?? "amqp://admin:admin123@localhost:5672",
    exchange: "mcp.examples",
    queuePrefix: "mcp.example",
  },
);
if (!result.started) {
  console.error(result.error); // recovery keeps retrying in the background
}

runtime.getStatus(); // connected, exchange, recovery state: what a health endpoint needs
process.on("SIGTERM", () => void runtime.stop());
```

A request in flight when the transport is rebuilt is never answered. Clients own timeout and
retry. [docs/getting-started.md](docs/getting-started.md) covers options, TLS, logging and custom
routing.

---

## How it works

All traffic goes through one durable topic exchange, `${exchangeName}.mcp.routing`.

| Routing key | Published by | Consumed by |
| --- | --- | --- |
| `mcp.request.<method>` | clients | the server's endpoint queue |
| `mcp.client-notification.<method>` | clients | the server's endpoint queue |
| `mcp.server-notification.<method>` | the server | every client |

`<method>` is the JSON-RPC method with `/` replaced by `.`, so `tools/call` routes as
`mcp.request.tools.call`.

- **Responses skip the exchange.** Each request carries `replyTo` and `correlationId`. The server
  answers straight to that client's exclusive reply queue.
- **Two clients can both send `id: 1`.** The server rewrites every request id to a unique internal
  id before the SDK sees it, and restores the client's id on the response. It never routes a
  response by the id a client chose.
- **The body is the JSON-RPC message, nothing more.** Messages go out with
  `content_type: application/json`. An inbound message over 1 MiB (`maxMessageSize`), one that is
  not JSON, or one that is not valid JSON-RPC is dropped and reported through `onerror`. The
  server rejects it without requeue. The client acknowledges it and discards it.
- **`routingKeyStrategy` can change the suffix.** It must keep each message inside its namespace,
  and nothing enforces that. A key outside the patterns above matches no queue. The broker returns
  such a request, which then fails at once, and drops such a notification. Each transport logs a
  warning the first time its strategy leaves a namespace.

[docs/TRANSPORT_CONTRACT.md](docs/TRANSPORT_CONTRACT.md) is the normative statement of all of this.
`src/transports/__tests__/contract.test.ts` pins each clause by number.

---

## What 1.x does not do

- **One server per exchange.** Each server declares its own queue, and a topic exchange copies
  every request to every queue bound to it. A second server on the same exchange would receive
  and answer every request as well. Give each server its own `exchangeName`. Pools arrive in
  2.0.0.
- **No server-initiated requests.** Sampling and elicitation are unavailable. The server
  transport rejects an outbound request instead of publishing it.
- **No protocol session.** All clients share one endpoint. `initialize` gates nothing, and
  negotiated state is last-writer-wins.
- **The SDK client skips `initialize`.** `Client.connect()` skips the handshake when its
  transport has a `sessionId`, and `AMQPClientTransport` sets one. Calls still work, because the
  server gates nothing on `initialize`, but `getServerCapabilities()` and `getServerVersion()`
  return `undefined`, and `enforceStrictCapabilities` fails every call that needs a capability.
- **Server notifications are broadcast.** Every connected client receives every server
  notification, progress and log messages included.
- **Cancellation does not reach the server.** When a call times out or is aborted, the SDK client
  sends `notifications/cancelled`. The server transport rewrites request ids but not the id inside
  a cancellation, so the server never matches it, and the tool runs to completion.
- **No delivery guarantee.** The endpoint queue is not durable. A request published while no
  server is bound fails at once: the broker returns it, and the client fails the call with
  JSON-RPC error `-32000` (`data.reason: "no-route"`). A request in flight when the server goes
  away is not answered. That call fails only when the SDK's own request timeout expires: 60 s by
  default, or the `timeout` you pass per call. The transport's `responseTimeout` (30 s) reports
  the missing response through `onerror`, but does not end the call.
- **RabbitMQ only.** `amqplib` speaks AMQP 0-9.1. The examples run against RabbitMQ 3.12 and 4.4.
  Other 0-9.1 brokers are untested, and AMQP 1.0-only brokers cannot connect.

---

## MCP 2026-07-28 and 2.0.0

MCP 2026-07-28 removes the protocol session. There is no `initialize` handshake. Every request
carries its own protocol version and client capabilities, and a server must not rely on an earlier
request. Progress and log messages must stay with the request they belong to, which 1.x
broadcasts. The 2025-era model of one long-lived `Transport` per connection does not fit, so 2.0.0
is a re-architecture, not a patch.

- **[docs/BINDING.md](docs/BINDING.md) is the binding specification.** It is a draft, and its
  design was ratified on 2026-10-28. It defines:
  - the AMQP 0-9.1 topology for a pool of server instances;
  - the message mapping, and how envelope fields that mirror the body are checked;
  - exact cancellation across a pool;
  - deadlines, redelivery and the dead-letter policy;
  - a principal model, in which the broker-validated `user_id` becomes the request's `authInfo`;
  - serving 2025-era clients alongside 2026-era ones on the same broker;
  - a clause-by-clause mapping to the OASIS *MCP over AMQP 1.0* and *JSON-RPC 2.0 over AMQP 1.0*
    CSD01 drafts.
- **`@vibeforge-systems/amqp-mcp-transport/binding` is binding-core.** It is the wire rules of
  BINDING.md as pure functions, with no `amqplib`, no SDK and no I/O. Third-party implementers can
  use it to interoperate. The 1.x exports are unchanged.
- **The serving engine bridges each request to the 2.x SDK's `createMcpHandler`.** A spike against
  SDK 2.4.0 and RabbitMQ 4.4.0 measured the bridge on an 81-tool server: 0.46 ms at p50 and
  6.0 ms at p99 per `tools/call`. The method and the numbers are in
  [docs/history/](docs/history/spike-phase2-2026-10-28/README.md).

Review of the binding is welcome, from MCP implementers and from the OASIS AMQP TC alike. Open an
issue against BINDING.md.

---

## Used by

- **[MCP Open Discovery](https://github.com/VibeForge-Systems/mcp-open-discovery)** is an
  infrastructure-discovery MCP server, and uses this package as its AMQP transport. It pins a
  release tarball, and its merge bar runs its own AMQP contract tests against the installed
  package, so an upgrade that breaks a clause fails there too.

**Related:** the [MCP Open Discovery Marketplace](https://www.mcp-open-discovery.com) is Open
Discovery's registry of signed plugins.

---

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/getting-started.md](docs/getting-started.md) | Install, broker setup, server, client, runtime, options, TLS, logging |
| [docs/api-reference.md](docs/api-reference.md) | Every export, every option and its default |
| [docs/troubleshooting.md](docs/troubleshooting.md) | The failures that actually happen, and what each one means |
| [docs/TRANSPORT_CONTRACT.md](docs/TRANSPORT_CONTRACT.md) | The normative 1.x wire behaviour |
| [docs/BINDING.md](docs/BINDING.md) | The draft MCP 2026-07-28 binding for 2.0.0 |
| [docs/history/](docs/history/) | Dated records: the February 2026 audit, the re-architecture plan, the engine spike |

---

## Development

```bash
npm install
npm test             # Jest; the tests inject a fake connection, so no broker is needed
npm run lint
npm run typecheck
npm run build        # dist/
```

- **CI.** `.github/workflows/ci.yml` runs lint, the typecheck, the build, the tests on Node 18, 20
  and 22, and the examples build.
- **Releases.** A `vX.Y.Z` tag builds, tests and packs the package, then publishes a GitHub Release
  with the tarball and its SHA-256 attached. Publishing to npm is a separate, manual workflow.

```text
src/transports/   the 1.x client and server transports, AmqpServerRuntime and utilities
src/binding/      binding-core, exported as /binding
examples/         the client and server behind npm run example:*
docs/             the documents above; docs/history/ holds the dated records
```

---

## Versioning

The package follows [Semantic Versioning](https://semver.org/).

- **1.x** is the 2025-era wire format in TRANSPORT_CONTRACT.md.
- **2.0.0** is MCP 2026-07-28, as specified in BINDING.md. It serves 2025-era clients alongside
  2026-era ones (BINDING §11).
- **Moving from `amqp-mcp-transport`** is a change of dependency name and import specifier. The
  exports, the exchange and the routing keys are the same.

---

## Support

**Community.** Report bugs and request features through
[GitHub issues](https://github.com/VibeForge-Systems/amqp-mcp-transport/issues).

**Commercial.** [VibeForge Systems](https://www.vibeforgesystems.com/) offers commercial support for
MCP-over-AMQP deployments.

**Security.** Report vulnerabilities privately, through a
[GitHub security advisory](https://github.com/VibeForge-Systems/amqp-mcp-transport/security/advisories/new),
never a public issue. [SECURITY.md](SECURITY.md) describes the process and the supported versions.

---

## Contributing and licence

- Start with [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Release history is in [CHANGELOG.md](CHANGELOG.md).

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE).

Built by [VibeForge Systems](https://www.vibeforgesystems.com/).
