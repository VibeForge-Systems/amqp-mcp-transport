# Getting started

This guide takes an MCP server and client from nothing to talking through RabbitMQ, then covers
what a deployment needs: names, recovery, timeouts, TLS and logging. It describes 1.x, which serves
the 2025-era protocol through `@modelcontextprotocol/sdk` v1. Every option and default is in
[api-reference.md](./api-reference.md).

## Prerequisites

- Node 22 or later.
- `@modelcontextprotocol/sdk` 1.17.1 or later, below 2. It is a peer dependency, so your
  application installs it.
- RabbitMQ. The examples run against 3.12 and 4.4. Other AMQP 0-9.1 brokers are untested.
- `zod`, for the server example's input schema: `npm install zod`.

The snippets use top-level `await`, so run them as ES modules.

## Install

```bash
npm install @vibeforge-systems/amqp-mcp-transport @modelcontextprotocol/sdk
```

npm publication of 1.3.0 is pending. Until it lands, install the release tarball:

```bash
npm install https://github.com/VibeForge-Systems/amqp-mcp-transport/releases/download/v1.3.0/vibeforge-systems-amqp-mcp-transport-1.3.0.tgz @modelcontextprotocol/sdk
```

To track unreleased work, install `main` from GitHub instead:

```bash
npm install github:VibeForge-Systems/amqp-mcp-transport
```

The `prepare` script builds it on install. The package is ESM.
CommonJS code on Node 20.19 or later, or 22.12 or later, can `require()` it.

## Start a broker

The repository's `docker-compose.yml` runs RabbitMQ 3.12 with the management UI:

```bash
docker compose up -d
export AMQP_URL=amqp://admin:admin123@localhost:5672
```

The management UI is at <http://localhost:15672>. The compose login is a placeholder: change
`RABBITMQ_DEFAULT_USER` and `RABBITMQ_DEFAULT_PASS` before the broker is reachable from a network
you do not control.

## Server

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
  amqpUrl: process.env.AMQP_URL!,
  exchangeName: "mcp.examples",
  queuePrefix: "mcp.example",
});

await server.connect(transport); // the SDK calls transport.start(); do not call it yourself
```

`server.connect()` rejects if the broker is unreachable. The low-level `Server` class from
`@modelcontextprotocol/sdk/server/index.js` works the same way; `examples/server.ts` uses it.

## Client

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AMQPClientTransport } from "@vibeforge-systems/amqp-mcp-transport";

const transport = new AMQPClientTransport({
  amqpUrl: process.env.AMQP_URL!,
  exchangeName: "mcp.examples",   // must match the server's
  serverQueuePrefix: "mcp.example",
});

const client = new Client({ name: "echo-client", version: "1.0.0" });
await client.connect(transport);

const result = await client.callTool({ name: "echo", arguments: { text: "hello" } });
await client.close();
```

`Client.connect()` does not send `initialize` over this transport, so `getServerCapabilities()`
and `getServerVersion()` return `undefined`. Calls work regardless. The README's
[What 1.x does not do](../README.md#what-1x-does-not-do) explains why.

## Names

| Option | Side | What it does |
| --- | --- | --- |
| `exchangeName` | both | Both sides use the topic exchange `${exchangeName}.mcp.routing`. Client and server find each other through it alone. |
| `queuePrefix` | server | The server consumes from `${queuePrefix}.requests.<uuid>`, a new exclusive queue per transport. |
| `serverQueuePrefix` | client | Required, but 1.x does not route by it. |

Give each server its own `exchangeName`. Every server bound to an exchange receives every request
on it, so two servers on one exchange would both answer.

## Keep a server up

The transport reconnects by itself: by default every 5 seconds, up to 10 times, keeping its queue
name. After that it closes for good. `AmqpServerRuntime` takes over from there. It builds a new
transport and a new server from your factory, and retries with exponential backoff until it
connects.

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
  {
    create: async () => buildServer(),         // called on every attach
    release: (server) => {},                   // optional: that server's transport has gone
  },
  {
    enabled: true,
    url: process.env.AMQP_URL!,
    exchange: "mcp.examples",
    queuePrefix: "mcp.example",
    recoveryRetryInterval: 30_000,             // these four are the defaults
    recoveryBackoffMultiplier: 1.5,
    recoveryMaxRetryInterval: 300_000,
    recoveryMaxRetries: -1,                    // -1 retries forever
  },
);
```

- **`start()` does not throw.** A broker failure, an invalid config or a `create()` that throws
  comes back as `{ started: false, error }`, and recovery keeps retrying in the background unless
  `autoRecoveryEnabled` is `false`. It retries an invalid config too, which never succeeds, so
  check `result.error`.
- **Build a new server in `create()`.** The runtime calls it on every attach and binds whatever it
  returns. A fresh server carries no state from an earlier connection.
- **`getStatus()` is what a health endpoint needs.** It reports `connected` and the recovery
  loop's retry count, next retry time and last error. While a transport is attached, it also
  reports the exchange, the queue prefix and the transport's last error.
- **`stop()` cancels recovery and closes the transport.** Call it on shutdown.
- **`send()` publishes a server notification** through whichever transport is current, such as
  `notifications/tools/list_changed`. It accepts notifications only.

A request in flight when the transport is rebuilt is never answered. Clients own timeout and
retry.

## Timeouts

A request that no server is bound for fails at once with JSON-RPC error `-32000` and
`data.reason: "no-route"`, because the broker returns it. A request that reaches a server but gets
no answer fails on the SDK's request timeout: 60 seconds by default. Set it per call:

```ts
await client.callTool({ name: "echo", arguments: { text: "hi" } }, undefined, { timeout: 10_000 });
```

The transport's `responseTimeout` (default 30 seconds) is separate. When it expires, the transport
stops tracking the request and reports it through `onerror`, but the call itself still waits for
the SDK timeout. A response that arrives after `responseTimeout` is still delivered.

When the SDK gives up on a call, it sends `notifications/cancelled`. The 1.x server does not act on
it, so the tool runs to completion, and the client reports the late response through `onerror`.

## TLS, virtual hosts and heartbeats

The transport passes `amqpUrl` to `amqplib.connect()` unchanged, so everything is set in the URL:

```text
amqps://user:password@broker.example.com:5671/my-vhost?heartbeat=30
```

- **`amqps://`** connects with TLS and verifies the broker against Node's default CA bundle. For a
  private CA, set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` in the environment before Node starts.
  Node reads it only at startup.
- **Client certificates are not supported.** The transport passes no socket options to
  `amqplib`, so mutual TLS is out of reach in 1.x. Authenticate with a username and password.
- **The path is the virtual host.** Percent-encode it: `/` as the vhost is `%2F`.
- **`heartbeat`**, `frameMax` and `channelMax` are query parameters. Without `heartbeat`, the
  broker's value applies.

Percent-encode any reserved characters in the username or password.

## Logging

Both transports and the runtime accept a `logger` with `debug`, `info`, `warn` and `error`
methods. The default writes warnings and errors to stderr and drops the rest. The runtime passes
its logger to each transport it builds.

```ts
const transport = new AMQPServerTransport({
  amqpUrl: process.env.AMQP_URL!,
  exchangeName: "mcp.examples",
  queuePrefix: "mcp.example",
  logger: {                                   // log is your application's logger
    debug: (msg, ctx) => log.debug(ctx, msg),
    info: (msg, ctx) => log.info(ctx, msg),
    warn: (msg, ctx) => log.warn(ctx, msg),
    error: (msg, ctx) => log.error(ctx, msg),
  },
});
```

The logger receives the transports' warnings, such as a failed teardown or a routing key outside
its namespace. Errors do not go to it.
Connection failures, consumer cancels, dropped messages and response timeouts go only to the
transport's `onerror`. With no `onerror` set, nothing reports them.

On `connect()`, the SDK keeps any `onerror` you set on the transport and forwards every error to
the `onerror` of your `Client` or `Server` as well, so set either one:

```ts
server.server.onerror = (error) => log.error({ error }, "AMQP transport error"); // McpServer
client.onerror = (error) => log.error({ error }, "AMQP transport error");
```

## Custom routing keys

`routingKeyStrategy` replaces the default `mcp.<namespace>.<method>` key:

```ts
routingKeyStrategy: (message, routingType) => {
  const method = "method" in message ? message.method.replace(/\//g, ".") : "unknown";
  return `mcp.${routingType}.myapp.${method}`;
},
```

Each key must stay inside its namespace: `mcp.request.#`, `mcp.client-notification.#` or
`mcp.server-notification.#`, as `routingType` says. A key outside those patterns matches no queue.
The broker returns such a request, which then fails with `no-route`, and drops such a
notification. Each transport logs a warning the first time its strategy leaves a namespace, and
still publishes the message.

## Run the examples

From a clone of the repository, with the broker above running:

```bash
npm run example:server       # terminal 1
npm run example:client       # terminal 2
```

Both read `AMQP_URL` and `AMQP_EXCHANGE` (default `mcp.examples`). Without `AMQP_URL` they use
`amqp://guest:guest@localhost:5672`, which the compose broker refuses, so export `AMQP_URL` in
both terminals. The client lists the server's tools, resources and prompts, calls a tool and reads
a resource.
