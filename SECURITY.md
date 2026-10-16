# Security policy

## Reporting a problem

Please don't report security problems in public GitHub issues. Use GitHub's private vulnerability reporting on this repository (Security tab, then "Report a vulnerability").

It helps to include the file and line or the commit, the steps to reproduce, and what an attacker could do with it.

## How this stack protects itself

The short version is below. [docs/security.md](docs/security.md) has the details and the reasons.

- The function's role writes only to its own log group and can only read and create orders.
- Request and order IDs go into log fields, not metric dimensions, and the handler doesn't log the full event.
- The handler checks input IDs against a strict pattern before they reach DynamoDB or a log line.
- The alarm topic refuses requests that don't use TLS.
