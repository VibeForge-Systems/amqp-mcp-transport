/**
 * Routing-key resolution shared by both transports.  Internal: the package
 * index does not export this module.
 *
 * A custom `routingKeyStrategy` MUST keep each message inside its namespace
 * (docs/TRANSPORT_CONTRACT.md, Topology).  The wire cannot enforce that: a
 * key outside `mcp.<routingType>.#` matches no queue the other side binds,
 * and the broker drops the message.  The resolver says so once per
 * namespace, so a misconfigured strategy does not fail in silence.  It warns
 * rather than throws, because a deployment may bind its own queues to custom
 * keys on the same exchange.
 */

import { getRoutingKey } from "./amqp-utils.js";
import type { JSONRPCMessage, RoutingKeyStrategy, RoutingMessageType, TransportLogger } from "./types.js";

/** True when `routingKey` matches `mcp.<routingType>.#`, the pattern the receiving side binds. */
export function isRoutingKeyInNamespace(routingKey: string, routingType: RoutingMessageType): boolean {
    const prefix = `mcp.${routingType}`;
    return routingKey === prefix || routingKey.startsWith(`${prefix}.`);
}

export type RoutingKeyResolver = (message: JSONRPCMessage, routingType: RoutingMessageType) => string;

export function createRoutingKeyResolver(
    strategy: RoutingKeyStrategy | undefined,
    logger: TransportLogger,
): RoutingKeyResolver {
    const warned = new Set<RoutingMessageType>();
    return (message, routingType) => {
        const routingKey = getRoutingKey(message, routingType, strategy);
        if (!warned.has(routingType) && !isRoutingKeyInNamespace(routingKey, routingType)) {
            warned.add(routingType);
            logger.warn(
                `routingKeyStrategy returned '${routingKey}' for a ${routingType} message. Only keys under ` +
                `mcp.${routingType}.# reach the other side, so the broker will not deliver it. ` +
                `This warning is logged once per namespace.`,
                { routingKey, routingType },
            );
        }
        return routingKey;
    };
}
