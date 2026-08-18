# Security Policy

NexusPilot handles database connection profiles, AI provider configuration, local application data, and optional encrypted Cloud synchronization. We take reports about security vulnerabilities seriously.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through one of these channels:

1. GitHub Private Vulnerability Reporting, when enabled for the public repository.
2. Email: [support@nexuspilot.dev](mailto:support@nexuspilot.dev)

Do not report security vulnerabilities through a public GitHub Issue, Pull Request, discussion, or public chat.

Please include as much of the following information as you can:

- Affected NexusPilot version or commit.
- Operating system and relevant runtime versions.
- A clear description of the vulnerability and its potential impact.
- Reproduction steps or a minimal proof of concept.
- The affected component, such as the desktop client, AI Runtime, authentication flow, or Cloud synchronization client.
- Any suggested mitigation, if known.

Please do not include passwords, API keys, access tokens, private signing keys, complete database connection strings, customer data, or other sensitive business information in the report. Redact logs and screenshots before sending them.

## Response process

We will acknowledge a report after reviewing the available information, confirm whether it is in scope, and coordinate remediation and disclosure with the reporter when appropriate. The response timeline may depend on the reproducibility, severity, and affected release channel.

Please avoid publicly disclosing the issue until a fix or mitigation has been coordinated. We may credit reporters who prefer to be acknowledged, subject to their consent.

## Scope notes

Security reports may cover the public NexusPilot desktop client, AI Runtime, website, authentication integration, and the open-source Cloud synchronization client. The separately maintained NexusPilot Cloud server has its own deployment and operational boundaries; reports about the public client should still be sent through the channels above so they can be routed appropriately.

The Apache-2.0 license does not grant permission to use NexusPilot or NIEEX trademarks, logos, or third-party database branding outside their applicable policies.
