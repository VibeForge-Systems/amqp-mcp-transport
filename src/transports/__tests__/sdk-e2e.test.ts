/**
 * End-to-end through the real MCP SDK: McpServer + two Clients over an
 * in-memory broker that implements topic routing, exclusive queues and
 * direct queue delivery.  Proves the id rewrite survives the SDK's own
 * request/response bookkeeping (relatedRequestId), not just a hand-driven
 * mock.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AMQPClientTransport } from "../amqp-client-transport";
import { AMQPServerTransport } from "../amqp-server-transport";

type Delivery = { content: Buffer; properties: Record<string, unknown>; fields: { deliveryTag: number } };

function topicMatches(pattern: string, key: string): boolean {
    const p = pattern.split('.');
    const k = key.split('.');
    const walk = (i: number, j: number): boolean => {
        if (i === p.length) return j === k.length;
        if (p[i] === '#') return walk(i + 1, j) || (j < k.length && walk(i, j + 1));
        if (j === k.length) return false;
        return (p[i] === '*' || p[i] === k[j]) && walk(i + 1, j + 1);
    };
    return walk(0, 0);
}

function createBroker() {
    const queues = new Map<string, Array<(d: Delivery) => void>>();
    const bindings: Array<{ exchange: string; queue: string; pattern: string }> = [];
    let seq = 0;
    const deliver = (queue: string, content: Buffer, properties: Record<string, unknown>) => {
        for (const consumer of queues.get(queue) ?? []) {
            // Deliver asynchronously, like a real broker.
            setImmediate(() => consumer({ content: Buffer.from(content), properties, fields: { deliveryTag: ++seq } }));
        }
    };
    const channel = () => {
        const listeners = new Map<string, Array<(value: unknown) => void>>();
        return {
            on(event: string, listener: (value: unknown) => void) {
                listeners.set(event, [...(listeners.get(event) ?? []), listener]);
            },
            async prefetch() {},
            async assertExchange() {},
            async assertQueue(name: string) {
                const queue = name || `amq.gen-${++seq}`;
                if (!queues.has(queue)) queues.set(queue, []);
                return { queue };
            },
            async bindQueue(queue: string, exchange: string, pattern: string) { bindings.push({ exchange, queue, pattern }); },
            async consume(queue: string, cb: (d: Delivery) => void) { queues.get(queue)!.push(cb); return { consumerTag: queue }; },
            publish(exchange: string, routingKey: string, content: Buffer, options: Record<string, unknown> = {}) {
                let routed = false;
                for (const b of bindings) {
                    if (b.exchange === exchange && topicMatches(b.pattern, routingKey)) {
                        routed = true;
                        deliver(b.queue, content, options);
                    }
                }
                if (!routed && options.mandatory) {
                    // basic.return: asynchronous, on the channel that published.
                    const returned = {
                        content: Buffer.from(content),
                        properties: options,
                        fields: { replyCode: 312, replyText: 'NO_ROUTE', exchange, routingKey },
                    };
                    setImmediate(() => { for (const listener of listeners.get('return') ?? []) listener(returned); });
                }
                return true;
            },
            sendToQueue(queue: string, content: Buffer, options: Record<string, unknown> = {}) { deliver(queue, content, options); return true; },
            ack() {},
            nack() {},
            async close() {},
        };
    };
    return {
        connect: async () => ({ async createChannel() { return channel() as any; }, on() {}, async close() {} }),
    };
}

describe('SDK end-to-end over an in-memory broker', () => {
    it('two concurrent SDK clients reusing the same request ids each get their own results', async () => {
        const broker = createBroker();
        const base = { amqpUrl: 'amqp://broker', exchangeName: 'e2e' };

        const server = new McpServer({ name: 'e2e-server', version: '1.0.0' });
        server.tool('whoami', { caller: z.string() }, async ({ caller }) => {
            // Stagger so responses interleave across the two clients.
            await new Promise((resolve) => setTimeout(resolve, caller === 'alice' ? 20 : 1));
            return { content: [{ type: 'text', text: `hello ${caller}` }] };
        });
        const serverTransport = new AMQPServerTransport({ ...base, queuePrefix: 'e2e' });
        serverTransport._connectFn = broker.connect;
        await server.connect(serverTransport);

        const makeClient = async () => {
            const transport = new AMQPClientTransport({ ...base, serverQueuePrefix: 'e2e' });
            transport._connectFn = broker.connect;
            const client = new Client({ name: 'e2e-client', version: '1.0.0' });
            await client.connect(transport);
            return client;
        };
        const alice = await makeClient();
        const bob = await makeClient();

        // Both clients' SDKs number requests identically, so these calls carry the same ids.
        const [a, b] = await Promise.all([
            alice.callTool({ name: 'whoami', arguments: { caller: 'alice' } }),
            bob.callTool({ name: 'whoami', arguments: { caller: 'bob' } }),
        ]);

        expect(a.content).toEqual([{ type: 'text', text: 'hello alice' }]);
        expect(b.content).toEqual([{ type: 'text', text: 'hello bob' }]);

        await alice.close();
        await bob.close();
        await server.close();
    });

    it('a client with no server bound fails at once instead of waiting for the SDK timeout', async () => {
        const broker = createBroker();
        const transport = new AMQPClientTransport({ amqpUrl: 'amqp://broker', exchangeName: 'e2e-no-server', serverQueuePrefix: 'e2e' });
        transport._connectFn = broker.connect;
        const client = new Client({ name: 'e2e-client', version: '1.0.0' });
        await client.connect(transport);

        // No queue is bound for the request. Without the broker's return, the call
        // would wait out the SDK's 60 s request timeout.
        const started = Date.now();
        await expect(client.listTools()).rejects.toMatchObject({
            code: -32000,
            data: { reason: 'no-route', routingKey: 'mcp.request.tools.list' },
        });
        expect(Date.now() - started).toBeLessThan(1_000);
        await client.close();
    });
});
