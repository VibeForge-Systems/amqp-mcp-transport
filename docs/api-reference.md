# API reference

Everything `@vibeforge-systems/amqp-mcp-transport` exports, for 1.x. The wire behaviour behind it
is [TRANSPORT_CONTRACT.md](./TRANSPORT_CONTRACT.md). For a guided tour, read
[getting-started.md](./getting-started.md) first.

| Entry point | Contents |
| --- | --- |
| `@vibeforge-systems/amqp-mcp-transport` | The transports, `AmqpServerRuntime`, the utilities and their types |
| `@vibeforge-systems/amqp-mcp-transport/binding` | binding-core, the pure wire rules of the draft 2.x binding |

## AMQPClientTransport

```ts
new AMQPClientTransport(options: AMQPClientTransportOptions)
```

An MCP SDK `Transport` for a `Client`. `AmqpClientTransport` is the same class.

- **The constructor throws** if `amqpUrl`, `exchangeName` or `serverQueuePrefix` is missing.
- **`start()`** connects, declares the exchange, an exclusive reply queue and an exclusive
  notification queue bound to `mcp.server-notification.#`. `Client.connect()` calls it. It is
  idempotent and rejects if the broker is unreachable.
- **`send(message)`** publishes a request under `mcp.request.<method>` with `replyTo` and a new
  `correlationId`, or a notification under `mcp.client-notification.<method>`. It throws
  `Transport not connected` while disconnected, and throws for a JSON-RPC response, since servers
  send no requests over this transport.
- **`close()`** stops reconnecting, forgets pending requests, closes the channel and connection,
  and fires `onclose` once.
- **`sessionId`** is a client-local UUID that namespaces correlation ids. It is not an MCP session
  and never goes on the wire. Because it is set, `Client.connect()` skips `initialize`.
- **`onmessage`, `onerror`, `onclose`** are the SDK's callbacks.

Reconnecting gives the client a new reply queue, so a response to a request sent before the
reconnect never arrives.

## AMQPServerTransport

```ts
new AMQPServerTransport(options: AMQPServerTransportOptions)
```

An MCP SDK `Transport` for an `McpServer` or `Server`. `AmqpServerTransport` is the same class.

- **The constructor throws** if `amqpUrl`, `exchangeName` or `queuePrefix` is missing, or if
  `validateAmqpConfig` reports an error.
- **`start()`** connects and consumes from `${queuePrefix}.requests.<sessionId>`, an exclusive,
  auto-deleting, non-durable queue bound to `mcp.request.#` and `mcp.client-notification.#`.
  `server.connect()` calls it. It is idempotent and rejects if the broker is unreachable.
- **`send(message, options)`** answers a request on the requesting client's reply queue, or
  publishes a notification under `mcp.server-notification.<method>`. It throws for a request
  (§5 of the contract), for a response with no stored routing entry, and while disconnected.
- **`close()`** stops reconnecting, clears the routing store, closes the channel and connection,
  and fires `onclose` and `ontransportclosed` once.
- **`getStatus()`** returns an `AmqpTransportStatus`: `connected`, `exchange`, `queuePrefix` and
  the last error.
- **`sessionId`** is the endpoint-instance id that names the queue. It is not an MCP session.
- **`ontransportclosed(error?)`** fires once when the transport closes for good: on `close()`, or
  when reconnecting has run out of attempts. `AmqpServerRuntime` uses it.

Before the SDK sees a request, the transport replaces its id with a unique internal id, and it
restores the client's id on the response. A routing entry that no response consumes is dropped
after `messageTTL`.

## AmqpServerRuntime

```ts
new AmqpServerRuntime<TServer extends ConnectableServer>(options?: { logger?: TransportLogger })
```

Owns one `AMQPServerTransport` and the server bound to it, and rebuilds both after the transport
closes for good. `NativeAmqpRuntimeAdapter` is the same class.

| Method | Returns | Does |
| --- | --- | --- |
| `start(factory, config)` | `Promise<AmqpRuntimeStartResult>` | Attaches a transport and a server from `factory.create()`. Never throws for a broker failure: it returns `{ started: false, error }` and schedules recovery. Returns `{ started: false }` without connecting when `config.enabled` is `false`. |
| `stop()` | `Promise<void>` | Cancels recovery, closes the transport and releases the server. |
| `getStatus()` | `AmqpTransportStatus` | The transport's status plus `recovery`: `state` (`disabled`, `idle`, `waiting`, `attempting`, `stopped`), `retryCount`, `nextRetryAt`, `lastAttemptAt`, `lastError`. |
| `send(notification, options?)` | `Promise<void>` | Publishes a server notification through the current transport. Throws when there is none. |

**`AmqpServerFactory<TServer>`** has `create(): Promise<TServer>`, called on every attach, and an
optional `release(server)`, called when that server's transport has gone. Return a new server
from every `create()`.

**`AmqpRuntimeConfig`** uses Open Discovery's field names:

| Field | Default | Maps to |
| --- | --- | --- |
| `enabled` | required | `false` makes `start()` a no-op |
| `url`, `exchange`, `queuePrefix` | required | `amqpUrl`, `exchangeName`, `queuePrefix` |
| `prefetch` | none | `prefetchCount` |
| `reconnectDelay`, `maxReconnectAttempts`, `messageTTL`, `queueTTL`, `maxMessageSize`, `routingKeyStrategy` | as the server transport | the transport option of the same name |
| `autoRecoveryEnabled` | `true` | `false` disables runtime recovery |
| `recoveryRetryInterval` | 30 000 ms | first delay after the transport closes |
| `recoveryBackoffMultiplier` | 1.5 | growth per failed attempt |
| `recoveryMaxRetryInterval` | 300 000 ms | cap on the delay |
| `recoveryMaxRetries` | -1 | -1 retries forever |
| `mode` | none | optional, and only `'amqp'`: accepted for Open Discovery compatibility |

## Options

`AMQPTransportOptions` are shared. `AMQPClientTransportOptions` and `AMQPServerTransportOptions`
extend them.

| Option | Client default | Server default | Meaning |
| --- | --- | --- | --- |
| `amqpUrl` | required | required | `amqp://` or `amqps://` URL, passed to `amqplib.connect()` unchanged |
| `exchangeName` | required | required | Prefix of the topic exchange `${exchangeName}.mcp.routing` |
| `serverQueuePrefix` | required | | Required, not used for routing in 1.x |
| `queuePrefix` | | required | Prefix of the server's queue name |
| `reconnectDelay` | 5 000 ms | 5 000 ms | Delay between reconnect attempts. The server requires at least 1 000. |
| `maxReconnectAttempts` | 10 | 10 | Attempts before the transport closes for good. The server requires at least 1. |
| `prefetchCount` | 10 | none (unlimited) | Unacknowledged deliveries per consumer |
| `messageTTL` | 60 000 ms | 3 600 000 ms | `x-message-ttl` on the transport's queues. The server also drops unanswered routing entries after it. |
| `queueTTL` | 300 000 ms | 7 200 000 ms | `x-expires` on the transport's queues |
| `maxMessageSize` | 1 048 576 bytes | 1 048 576 bytes | Larger inbound messages are dropped and reported through `onerror` |
| `responseTimeout` | 30 000 ms | | Stops tracking an unanswered request and reports it through `onerror`. The SDK call fails on its own timeout. |
| `routingKeyStrategy` | default | default | `(message, routingType) => string`. Must keep each key inside its namespace. |
| `logger` | stderr | stderr | `TransportLogger`: `debug`, `info`, `warn`, `error`. The default prints warnings and errors. |

## Utilities

The routing helpers are what the transports themselves use.

| Export | Signature | Does |
| --- | --- | --- |
| `routingExchangeName` | `(exchangeName) => string` | `${exchangeName}.mcp.routing` |
| `ROUTING_PATTERNS` | `{ request, clientNotification, serverNotification }` | The three binding patterns |
| `defaultRoutingKeyStrategy` | `(message, routingType) => string` | `mcp.<routingType>.<method>`, with `/` as `.` |
| `getRoutingKey` | `(message, routingType, strategy?) => string` | Applies `strategy`, or the default |
| `normalizeMethodForRouting` | `(method) => string` | Replaces `/` with `.` |
| `parseMessage` | `(content: Buffer \| string) => ParseResult` | Parses and validates; never throws |
| `validateJSONRPC` | `(obj: unknown) => JSONRPCMessage` | Throws if `obj` is not a JSON-RPC 2.0 message |
| `detectMessageType` | `(message) => 'request' \| 'response' \| 'notification'` | Classifies a message |
| `isJSONRPCRequest`, `isJSONRPCNotification` | type guards | |
| `sanitizeJsonRpcMessage` | `(message) => JSONRPCMessage` | Copies a message, sets `jsonrpc: "2.0"` if missing and removes `_rabbitMQ*` keys |
| `validateAmqpConfig` | `(config) => string[]` | The server constructor's checks; empty when valid |
| `generateSessionId`, `generateCorrelationId` | `() => string`, `(sessionId) => string` | The ids the transports use |
| `createDefaultLogger` | `(scope) => TransportLogger` | The default stderr logger |
| `getDefaultConfig` | `() => DefaultAMQPConfig` | Reads `AMQP_URL`, `AMQP_EXCHANGE` and other `AMQP_*` variables, with defaults |
| `createLogEntry` | `(transport, sessionId, operation, data?) => LogEntry` | A timestamped log record |

**Kept for Open Discovery compatibility.** Neither function checks a live connection, so use
`getStatus()` instead.

- `testAmqpConnection` expects an object with a public `connection`, which neither transport
  class has. It declares a `mcp.heartbeat` fanout exchange on the broker as a side effect.
- `getAmqpStatus` reports `connected: true` for any non-null argument.

## binding-core

`@vibeforge-systems/amqp-mcp-transport/binding` is the wire rules of the draft
[BINDING.md](./BINDING.md) as pure functions: no `amqplib`, no SDK, no I/O. A profile translates
its client library's message into an `InboundEnvelope`, asks binding-core what to do with it, and
performs the I/O itself. 1.x does not use it. The 2.0.0 serving engine will.

| Area | Main exports | BINDING |
| --- | --- | --- |
| Names and topology | `assertBindingNames`, `routingKeyFor`, `topologyNames`, `serverTopology`, `exchangeNames`, `eraOfExchange` | §2, §4 |
| Mirrors | `checkMirrors`, `expectedNameMirror`, the `HEADER_*` names | §5.2, §8 |
| Deadlines | `parseExpiration`, `requestDeadline`, `listenLifetimeMs` | §6.3, §7.1 |
| Inbound classification | `classifyInbound` | §6.1, §7.1, §7.4, §8 |
| Cancellation | `ExchangeRegistry` | §6.1, §6.4 |
| Outbound envelopes | `buildClientRequest`, `buildClientNotification`, `buildServerMessage`, `buildDeadLetter` | §4.2, §5.2, §7.4 |
| Principal | `authInfoFor` | §9.1, §9.2 |
| Redelivery | `redeliveryAction` | §7.2 |
| Errors | `errorResponse`, `HEADER_MISMATCH`, the dead-letter reasons | §7.4, §8 |

Each export's TSDoc states its rule. The binding is a draft, so these may change before 2.0.0.
