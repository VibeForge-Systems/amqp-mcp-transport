/**
 * @vibeforge-systems/amqp-mcp-transport: MCP client and server transports
 * over AMQP 0-9.1 (RabbitMQ), for the MCP TypeScript SDK v1.
 *
 * Hand the transport to the SDK; `connect()` calls `start()` for you.
 * The wire behaviour is docs/TRANSPORT_CONTRACT.md.
 *
 * @example Server
 * ```typescript
 * import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 * import { AMQPServerTransport } from "@vibeforge-systems/amqp-mcp-transport";
 *
 * const server = new McpServer({ name: "my-server", version: "1.0.0" });
 * await server.connect(new AMQPServerTransport({
 *   amqpUrl: "amqp://localhost:5672",
 *   exchangeName: "mcp.myapp",
 *   queuePrefix: "mcp.myapp",
 * }));
 * ```
 *
 * @example Client
 * ```typescript
 * import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 * import { AMQPClientTransport } from "@vibeforge-systems/amqp-mcp-transport";
 *
 * const client = new Client({ name: "my-client", version: "1.0.0" });
 * await client.connect(new AMQPClientTransport({
 *   amqpUrl: "amqp://localhost:5672",
 *   exchangeName: "mcp.myapp",
 *   serverQueuePrefix: "mcp.myapp",
 * }));
 * ```
 */

export * from "./transports/index.js";
