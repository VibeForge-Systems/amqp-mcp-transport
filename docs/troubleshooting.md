# Troubleshooting

The failures that happen with 1.x, what each one means, and what fixes it. Exchange and queue names
below assume `exchangeName: "mcp.examples"` and `queuePrefix: "mcp.example"`.

## The first check: the management UI

Most problems show up in RabbitMQ's management UI (<http://localhost:15672> with the bundled
compose file), or in `rabbitmqctl list_bindings`.

- **Exchanges** should list `mcp.examples.mcp.routing`, a durable topic exchange.
- **Its bindings** should include one queue named `mcp.example.requests.<uuid>`, bound twice: to
  `mcp.request.#` and to `mcp.client-notification.#`. That queue is the server. No such queue
  means no server is running on this exchange.
- **Each connected client** adds two server-named `amq.gen-…` queues: a reply queue with no
  binding, and a notification queue bound to `mcp.server-notification.#`.

## `connect()` rejects

The SDK calls `transport.start()`, so broker errors surface from `client.connect()` or
`server.connect()`.

| Error | Cause |
| --- | --- |
| `ECONNREFUSED` | Nothing listens at the host and port in `amqpUrl`. Check that the broker runs, and the port: 5672 for `amqp://`, usually 5671 for `amqps://`. |
| `ACCESS_REFUSED` (403) | Wrong username or password. RabbitMQ's `guest` user can only connect from localhost. |
| `NOT_ALLOWED` (530) on vhost | The virtual host in the URL path does not exist, or the user has no permissions on it. |
| `PRECONDITION_FAILED` (406) on the exchange | Something else declared `mcp.examples.mcp.routing` with a different type or durability. Delete it, or pick another `exchangeName`. |
| TLS errors such as `self-signed certificate` | The broker's certificate does not chain to a trusted CA. Set `NODE_EXTRA_CA_CERTS`. A TLS handshake against a plain `amqp` port fails too. |
| `Invalid AMQP server transport configuration` | Thrown by the server constructor: a URL scheme other than `amqp:` or `amqps:`, `reconnectDelay` under 1000, or `maxReconnectAttempts` or `prefetchCount` under 1. |

## Calls hang, then fail with `MCP error -32001: Request timed out`

The SDK gave up after its request timeout, 60 seconds unless you passed `timeout`. No response
came back. In order of likelihood:

1. **No server is bound to the exchange.** The two sides use different `exchangeName` values, or
   the server is not running. The broker drops a request no queue binds. Check the bindings above.
2. **A custom `routingKeyStrategy` left its namespace.** A request key that does not start with
   `mcp.request.` matches no queue.
3. **The server went away mid-request,** or its transport was rebuilt. In-flight requests are
   never answered. Retry.
4. **The tool is slower than the timeout.** Pass a larger `timeout` to the call.

## `Request timeout after 30000ms` in `onerror`, but the call succeeds

The transport's `responseTimeout` (30 seconds by default) expired before the response arrived. It
only reports; the response is still delivered and the call still completes. For tools that
routinely run longer, raise `responseTimeout` to match your call timeouts.

## Every request is answered twice, or tools run twice

Two servers are bound to the same exchange. A topic exchange copies each request to every bound
queue, so both servers run it, and the client receives two responses. Give each server its own
`exchangeName`.

## `getServerCapabilities()` returns `undefined`

Expected in 1.x. `Client.connect()` skips `initialize` because `AMQPClientTransport` sets
`sessionId`, so the client never learns the server's capabilities, version or instructions. Calls
work regardless. Do not enable `enforceStrictCapabilities`: with no capabilities recorded, it
fails every call that needs one.

## `Server-initiated requests are not supported over the AMQP transport`

A tool handler asked the client for something: sampling (`createMessage`), elicitation
(`elicitInput`) or `roots/list`. Those are server-to-client requests, which 1.x does not carry.
The handler has to work without them.

## `Incoming message exceeds maxMessageSize`

The receiving side dropped a message over `maxMessageSize`, 1 MiB by default. A server rejects it
without requeue. A client discards it, so the call then times out. Raise `maxMessageSize` on the
side that receives the large messages: the client for large tool results, the server for large
arguments.

## The server stops answering after a broker restart

The transport retries every `reconnectDelay` (5 seconds) up to `maxReconnectAttempts` (10). After
that, it reports `Maximum reconnection attempts exceeded` and closes for good. A server on a bare
transport stays down. Run it under `AmqpServerRuntime`, which keeps rebuilding it. Its
`getStatus().recovery` shows the next retry.

## `Already connected to a transport`

A server was bound to a second transport. With `AmqpServerRuntime`, `create()` must build a new
server every time it is called, not return one it built earlier.

## `AMQP broker cancelled the consumer on '…'`

The broker cancelled the transport's consumer, usually because its queue was deleted. The
transport treats this as a connection failure and reconnects. Requests in flight are not
answered.

## A client receives notifications it did not cause

Expected in 1.x. Server notifications are broadcast: every client on the exchange receives every
`notifications/message`, progress notification and `list_changed`.

Progress can be misattributed. The SDK uses a request's id as its progress token, and every client
numbers its requests from 0, so a client with request 3 in flight also receives another client's
progress for token 3, and passes it to its own `onprogress`. The SDK reports progress for a token
it is not waiting on through `onerror`.

## `ERR_REQUIRE_ESM`

The package is ESM. Node 22.12 and later can `require()` it. On older Node, use `import()`.

## Still stuck

Open an issue at <https://github.com/VibeForge-Systems/amqp-mcp-transport/issues> with the
transport options (without credentials), the error, the broker version, and the exchange's
bindings.
