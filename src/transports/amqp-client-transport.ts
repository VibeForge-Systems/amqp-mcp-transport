/**
 * AMQP Client Transport for Model Context Protocol
 *
 * Implements the MCP Transport interface over AMQP, sending raw JSON-RPC 2.0
 * messages as the message body with transport metadata carried in AMQP
 * message properties (correlationId, replyTo, contentType).
 *
 * Wire behaviour (normative text: docs/TRANSPORT_CONTRACT.md):
 *  - Requests publish under `mcp.request.<method>` with `replyTo` set to this
 *    client's exclusive reply queue and a fresh `correlationId`.
 *  - Requests publish `mandatory: true`.  When no server queue is bound for a
 *    request's key, the broker returns it, and the request fails at once with
 *    a no-route JSON-RPC error instead of waiting for the SDK's timeout.
 *  - Client notifications publish under `mcp.client-notification.<method>`.
 *  - Server notifications are received from `mcp.server-notification.#`.
 *  - Clients never send JSON-RPC responses: servers do not initiate requests
 *    over this transport.
 *  - Reconnection is suppressed after intentional close(), and a broker-side
 *    consumer cancel is treated as a connection failure.
 */

import type { Channel, ConsumeMessage } from 'amqplib';
import type {
    AMQPClientTransportOptions,
    ConnectionState,
    JSONRPCMessage,
    MessageExtraInfo,
    RequestId,
    Transport,
    TransportLogger,
    TransportSendOptions,
} from "./types.js";
import type { AMQPConnection } from "./amqp-server-transport.js";
import {
    ROUTING_PATTERNS,
    createDefaultLogger,
    detectMessageType,
    generateCorrelationId,
    generateSessionId,
    isJSONRPCRequest,
    routingExchangeName,
    validateJSONRPC,
} from "./amqp-utils.js";
import { createRoutingKeyResolver, type RoutingKeyResolver } from "./routing-key.js";

/**
 * JSON-RPC error code for a request the broker returned unrouted.  It is the
 * MCP SDK's `ErrorCode.ConnectionClosed`, which callers already treat as "the
 * server could not be reached".  The error's `data.reason` is `'no-route'`.
 */
const NO_ROUTE_ERROR_CODE = -32000;

// Request tracking
interface PendingRequest {
    id: RequestId;
    startTime: number;
    method: string | undefined;
    timeout: ReturnType<typeof setTimeout>;
    correlationId: string;
}

/** The parts of an amqplib `return` event the client reads. */
interface ReturnedMessage {
    properties?: { correlationId?: unknown };
    fields?: { replyCode?: unknown; replyText?: unknown; exchange?: unknown; routingKey?: unknown };
}

/**
 * AMQP Client Transport for Model Context Protocol
 */
export class AMQPClientTransport implements Transport {
    private connection: AMQPConnection | null = null;
    private channel: Channel | null = null;
    private responseQueue: string | null = null;

    private readonly connectionState: ConnectionState = { connected: false, reconnectAttempts: 0 };
    private readonly logger: TransportLogger;
    private readonly routingKeyFor: RoutingKeyResolver;
    private closing = false;
    private closeNotified = false;
    // True while connect() is intentionally tearing down the previous connection, so the old
    // connection's close/error listeners do not schedule a spurious reconnect.
    private reconnecting = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    /** Client-local id used to namespace correlation ids; never sent as an MCP session. */
    sessionId: string;

    // Correlation tracking
    private pendingRequests = new Map<string, PendingRequest>();

    private _protocolVersion?: string;

    // Transport interface callbacks
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

    /**
     * Injectable connect function for testing. When set, `start()` uses this
     * instead of importing amqplib.  The signature matches `amqplib.connect()`.
     * @internal
     */
    _connectFn?: (url: string) => Promise<AMQPConnection>;

    constructor(private options: AMQPClientTransportOptions) {
        this.validateOptions();

        this.options = {
            reconnectDelay: 5000,
            maxReconnectAttempts: 10,
            responseTimeout: 30000,
            prefetchCount: 10,
            messageTTL: 60000,
            queueTTL: 300000,
            maxMessageSize: 1_048_576,
            ...options
        };
        this.logger = options.logger ?? createDefaultLogger('AMQP_CLIENT_TRANSPORT');
        this.routingKeyFor = createRoutingKeyResolver(this.options.routingKeyStrategy, this.logger);
        this.sessionId = generateSessionId();
    }

    private validateOptions(): void {
        if (!this.options.amqpUrl) {
            throw new Error('amqpUrl is required');
        }
        if (!this.options.serverQueuePrefix) {
            throw new Error('serverQueuePrefix is required');
        }
        if (!this.options.exchangeName) {
            throw new Error('exchangeName is required');
        }
    }

    /**
     * Start the transport — idempotent as required by MCP SDK.
     */
    async start(): Promise<void> {
        if (this.connectionState.connected) {
            return;
        }
        this.closing = false;
        this.closeNotified = false;
        try {
            await this.connect();
            this.connectionState.connected = true;
            this.connectionState.reconnectAttempts = 0;
            this.connectionState.lastError = undefined;
        } catch (error) {
            const resolved = error instanceof Error ? error : new Error(String(error));
            this.connectionState.lastError = resolved;
            this.onerror?.(resolved);
            throw resolved;
        }
    }

    /**
     * Send a JSON-RPC message.
     *
     * The raw JSON-RPC message is sent as the AMQP body.  Transport metadata
     * (correlationId, replyTo) is carried in AMQP message properties.
     */
    async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
        if (!this.connectionState.connected || !this.channel) {
            throw new Error('Transport not connected');
        }

        const messageType = detectMessageType(message);
        const exchangeName = routingExchangeName(this.options.exchangeName);
        const messageBuffer = Buffer.from(JSON.stringify(message));

        switch (messageType) {
            case 'request':
                this.sendRequest(message, messageBuffer, exchangeName);
                break;
            case 'notification':
                this.sendNotification(message, messageBuffer, exchangeName);
                break;
            case 'response':
                // Nothing on the server side consumes client responses: servers do not initiate
                // requests over this transport. Failing loudly beats publishing into a void.
                throw new Error(
                    'Client responses are not supported over the AMQP transport: servers do not initiate ' +
                    'requests. See docs/TRANSPORT_CONTRACT.md §5.'
                );
        }
    }

    /**
     * Close the transport.
     */
    async close(): Promise<void> {
        this.closing = true;
        this.connectionState.connected = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        for (const [, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
        }
        this.pendingRequests.clear();

        try {
            await this.teardownConnection();
        } finally {
            this.notifyClosed();
        }
    }

    setProtocolVersion(version: string): void {
        this._protocolVersion = version;
    }

    get protocolVersion(): string | undefined {
        return this._protocolVersion;
    }

    // ── Private: connection setup ───────────────────────────────────────────

    private async teardownConnection(): Promise<void> {
        const channel = this.channel;
        const connection = this.connection;
        this.channel = null;
        this.connection = null;
        this.responseQueue = null;
        if (channel) {
            try {
                await channel.close();
            } catch (error) {
                this.logger.warn('Error closing AMQP channel during teardown', {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        if (connection) {
            try {
                await connection.close();
            } catch (error) {
                this.logger.warn('Error closing AMQP connection during teardown', {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    private async connect(): Promise<void> {
        // Tear down any previous connection first so a reconnect does not leak it.
        if (this.connection || this.channel) {
            this.reconnecting = true;
            try {
                await this.teardownConnection();
            } finally {
                this.reconnecting = false;
            }
        }

        const connectFn = this._connectFn ?? await this.loadConnectFn();
        this.connection = await connectFn(this.options.amqpUrl);
        this.connection.on('error', (error) => this.handleConnectionError(error));
        this.connection.on('close', () => this.handleConnectionClosed());

        this.channel = await this.connection.createChannel();
        this.channel.on('error', (error: unknown) =>
            this.handleConnectionError(error instanceof Error ? error : new Error(String(error))),
        );
        // Requests publish mandatory; the broker hands back any it cannot route.
        this.channel.on('return', (message: ReturnedMessage) => this.handleReturnedRequest(message));
        if (this.options.prefetchCount) {
            await this.channel.prefetch(this.options.prefetchCount);
        }

        await this.setupInfrastructure();
    }

    private async setupInfrastructure(): Promise<void> {
        if (!this.channel) throw new Error('AMQP channel not established');

        const exchangeName = routingExchangeName(this.options.exchangeName);
        await this.channel.assertExchange(exchangeName, 'topic', { durable: true });

        // Exclusive response queue
        const responseQueueResult = await this.channel.assertQueue('', {
            exclusive: true,
            autoDelete: true,
            arguments: {
                'x-message-ttl': this.options.messageTTL,
                'x-expires': this.options.queueTTL
            }
        });
        const responseQueue = responseQueueResult.queue;
        this.responseQueue = responseQueue;

        await this.channel.consume(responseQueue, (msg: ConsumeMessage | null) => {
            if (!msg) {
                this.handleConsumerCancelled(responseQueue);
                return;
            }
            this.handleResponse(msg);
            this.safeAck(msg);
        }, { noAck: false });

        await this.subscribeToNotifications(exchangeName);
    }

    // ── Private: message sending ────────────────────────────────────────────

    private sendRequest(message: JSONRPCMessage, messageBuffer: Buffer, exchangeName: string): void {
        if (!isJSONRPCRequest(message)) {
            throw new Error('Invalid request message format');
        }
        if (!this.responseQueue) {
            throw new Error('Response queue not available');
        }
        if (!this.channel) throw new Error('AMQP channel not established');

        const correlationId = generateCorrelationId(this.sessionId);
        const routingKey = this.routingKeyFor(message, 'request');

        this.setupRequestTimeout(correlationId, message.id, message.method);

        this.channel.publish(exchangeName, routingKey, messageBuffer, {
            correlationId,
            replyTo: this.responseQueue,
            contentType: 'application/json',
            timestamp: Date.now(),
            persistent: false,
            mandatory: true,
        });
    }

    private sendNotification(message: JSONRPCMessage, messageBuffer: Buffer, exchangeName: string): void {
        if (!this.channel) throw new Error('AMQP channel not established');

        const routingKey = this.routingKeyFor(message, 'client-notification');

        this.channel.publish(exchangeName, routingKey, messageBuffer, {
            contentType: 'application/json',
            persistent: false,
            timestamp: Date.now(),
        });
    }

    // ── Private: message receiving ──────────────────────────────────────────

    private handleResponse(msg: ConsumeMessage): void {
        try {
            if (msg.content.length > (this.options.maxMessageSize ?? 1_048_576)) {
                this.onerror?.(new Error(`Incoming message exceeds maxMessageSize (${msg.content.length} bytes)`));
                return;
            }

            const response = validateJSONRPC(JSON.parse(msg.content.toString()) as unknown);
            const rawCorrelationId: unknown = msg.properties?.correlationId;
            const correlationId = typeof rawCorrelationId === 'string' ? rawCorrelationId : undefined;

            if (correlationId) {
                const pending = this.pendingRequests.get(correlationId);
                if (pending) {
                    clearTimeout(pending.timeout);
                    this.pendingRequests.delete(correlationId);
                }
            }

            this.onmessage?.(response);
        } catch (error) {
            this.onerror?.(error as Error);
        }
    }

    private async subscribeToNotifications(exchangeName: string): Promise<void> {
        if (!this.channel) return;

        const notificationQueue = await this.channel.assertQueue('', {
            exclusive: true,
            autoDelete: true,
            arguments: {
                'x-message-ttl': this.options.messageTTL,
                'x-expires': this.options.queueTTL
            }
        });
        const queueName = notificationQueue.queue;

        // Server-originated notifications only; other clients' notifications live in the
        // client-notification namespace and must not reach this client.
        await this.channel.bindQueue(queueName, exchangeName, ROUTING_PATTERNS.serverNotification);

        await this.channel.consume(queueName, (msg: ConsumeMessage | null) => {
            if (!msg) {
                this.handleConsumerCancelled(queueName);
                return;
            }
            try {
                if (msg.content.length > (this.options.maxMessageSize ?? 1_048_576)) {
                    this.onerror?.(new Error(`Incoming notification exceeds maxMessageSize (${msg.content.length} bytes)`));
                } else {
                    const notification = validateJSONRPC(JSON.parse(msg.content.toString()));
                    this.onmessage?.(notification);
                }
            } catch (error) {
                this.onerror?.(error as Error);
            }
            this.safeAck(msg);
        }, { noAck: false });
    }

    // ── Private: timeout & correlation ───────────────────────────────────────

    /**
     * The broker returned a mandatory publish it could not route.
     *
     * Only requests publish mandatory, so a returned message is a request no
     * server queue received.  Nothing will ever answer it, so the request
     * fails now: the SDK receives a JSON-RPC error for the request's own id,
     * just as if a server had answered with one.
     */
    private handleReturnedRequest(message: ReturnedMessage): void {
        const correlationId =
            typeof message.properties?.correlationId === 'string' ? message.properties.correlationId : undefined;
        const pending = correlationId === undefined ? undefined : this.pendingRequests.get(correlationId);
        if (!correlationId || !pending) {
            return;
        }
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(correlationId);

        const fields = message.fields ?? {};
        const exchange = typeof fields.exchange === 'string' ? fields.exchange : undefined;
        const routingKey = typeof fields.routingKey === 'string' ? fields.routingKey : undefined;
        const replyCode = typeof fields.replyCode === 'number' ? fields.replyCode : undefined;
        const replyText = typeof fields.replyText === 'string' ? fields.replyText : undefined;
        const reply = [replyCode, replyText].filter((part) => part !== undefined).join(' ');

        this.onmessage?.({
            jsonrpc: '2.0',
            id: pending.id,
            error: {
                code: NO_ROUTE_ERROR_CODE,
                message:
                    `No MCP server is bound to exchange '${exchange ?? 'unknown'}' for routing key ` +
                    `'${routingKey ?? 'unknown'}'. The broker returned the request${reply ? ` (${reply})` : ''}.`,
                data: { reason: 'no-route', exchange, routingKey, replyCode, replyText },
            },
        } as JSONRPCMessage);
    }

    private setupRequestTimeout(correlationId: string, id: RequestId, method?: string): void {
        const timeoutMs = this.options.responseTimeout!;
        const timeout = setTimeout(() => {
            if (this.pendingRequests.has(correlationId)) {
                this.pendingRequests.delete(correlationId);
                this.onerror?.(new Error(`Request timeout after ${timeoutMs}ms for ${method ?? 'unknown'}`));
            }
        }, timeoutMs);
        timeout.unref?.();

        this.pendingRequests.set(correlationId, {
            id,
            startTime: Date.now(),
            method,
            timeout,
            correlationId
        });
    }

    private safeAck(msg: ConsumeMessage): void {
        if (this.channel) {
            try { this.channel.ack(msg); } catch { /* delivery tag may be stale */ }
        }
    }

    // ── Private: recovery ───────────────────────────────────────────────────

    private handleConsumerCancelled(queueName: string): void {
        if (this.closing || this.reconnecting) {
            return;
        }
        this.handleConnectionError(
            new Error(
                `AMQP broker cancelled the consumer on '${queueName}'. The connection is still open, but no ` +
                `response or notification can reach this client until the consumer is re-established.`,
            ),
        );
    }

    private handleConnectionError(error: Error): void {
        if (this.reconnecting) {
            return;
        }
        this.connectionState.connected = false;
        this.connectionState.lastError = error;
        this.onerror?.(error);
        if (!this.closing) {
            this.scheduleReconnect();
        }
    }

    private handleConnectionClosed(): void {
        if (this.reconnecting) {
            return;
        }
        this.connectionState.connected = false;
        if (!this.closing) {
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        const maxAttempts = this.options.maxReconnectAttempts ?? 10;
        if (this.closing || this.reconnectTimer) {
            return;
        }
        if (this.connectionState.reconnectAttempts >= maxAttempts) {
            const error = new Error('Maximum reconnection attempts exceeded');
            this.connectionState.lastError = error;
            this.onerror?.(error);
            this.notifyClosed();
            return;
        }

        this.connectionState.reconnectAttempts++;
        const delay = this.options.reconnectDelay ?? 5000;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.closing) return;
            void this.connect()
                .then(() => {
                    this.connectionState.connected = true;
                    this.connectionState.reconnectAttempts = 0;
                    this.connectionState.lastError = undefined;
                })
                .catch((error: unknown) => {
                    this.connectionState.lastError = error instanceof Error ? error : new Error(String(error));
                    this.scheduleReconnect();
                });
        }, delay);
        this.reconnectTimer.unref?.();
    }

    private notifyClosed(): void {
        if (this.closeNotified) {
            return;
        }
        this.closeNotified = true;
        this.onclose?.();
    }

    private async loadConnectFn(): Promise<(url: string) => Promise<AMQPConnection>> {
        try {
            const amqp = await import('amqplib');
            return async (url: string) => (await amqp.connect(url)) as unknown as AMQPConnection;
        } catch {
            throw new Error('amqplib package not found. Please install with: npm install amqplib');
        }
    }
}

/** Alias in the casing Open Discovery uses. */
export { AMQPClientTransport as AmqpClientTransport };
