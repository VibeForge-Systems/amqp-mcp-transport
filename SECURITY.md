# Security policy

## Supported versions

Security fixes land on `main` and ship in the next 1.x release. Earlier releases are not patched.

| Version | Supported |
| --- | --- |
| 1.2.x, and the next 1.x release | :white_check_mark: |
| 1.1.x and earlier | :x: |

1.1.0 and earlier have a cross-client response leak, fixed in 1.1.1. The
[CHANGELOG](CHANGELOG.md) describes it. Upgrade from them.

## Reporting a vulnerability

Report security problems **privately**. Do not open a public issue.

- **Preferred:** a private report through GitHub security advisories, at
  <https://github.com/VibeForge-Systems/amqp-mcp-transport/security/advisories/new>.
- **Otherwise:** contact the maintainers through the security contact on
  <https://www.vibeforgesystems.com/>.

Include:

- what the problem is and what an attacker gains;
- the affected version or commit;
- steps to reproduce, ideally a minimal proof of concept;
- a suggested fix, if you have one.

We aim to acknowledge a report within **3 business days**, and to give an initial assessment and
remediation plan within **10 business days**. We agree a disclosure date with you, and credit you
in the release notes unless you prefer otherwise.

## Security model

The transport moves MCP messages. Who may send them is decided by the broker, so deployment
security is mostly broker security.

- **The broker is the access control.** 1.x has no authentication or authorization of its own. A
  principal that can publish to `${exchangeName}.mcp.routing` can call every tool on the server
  bound to it. A principal that can bind a queue to that exchange can read every request, and
  every server notification. Give each server and client its own broker user, and restrict
  what each may configure, write and read with RabbitMQ's per-vhost permissions.
- **Use TLS beyond a trusted network.** `amqp://` sends credentials and messages in clear text.
  Use `amqps://`. The transport verifies the broker's certificate against Node's CA bundle.
- **The bundled credentials are placeholders.** `docker-compose.yml` publishes ports 5672 and
  15672 on every host interface with the login `admin` / `admin123`. Change both before the broker
  is reachable from a network you do not control.
- **Clients see each other's notifications.** Server notifications are broadcast to every client
  on the exchange, log messages and progress included. Do not put one client's data in a server
  notification if other clients on that exchange must not see it.
- **One server per exchange.** A second server bound to the same exchange receives every request
  too. Anyone who can bind a queue there can stand up such a server.
- **Message size is bounded.** Each side drops inbound messages over `maxMessageSize`, 1 MiB by
  default. The broker's own limits apply first.

The design for 2.0.0 adds a principal model, in which the broker-validated `user_id` becomes each
request's `authInfo`. [docs/BINDING.md](docs/BINDING.md) §9 specifies it. It is not in 1.x.
