# Security Policy

English | [中文](SECURITY.zh.md)

## Supported versions

Security fixes land on the current release line. Older versions are not patched.

| Version | Supported |
| --- | --- |
| `0.1.0` | yes |

## Reporting a vulnerability

- Report privately through GitHub's security advisory form rather than a public issue.
- Include the harness version, the plugin version, and the smallest reproduction you have.
- Expect an acknowledgement within a few days: this is a spare-time project.

## Scope

This plugin makes no network request of its own and reads no credential. It measures context pressure through the harness token meter, and it rewrites no history itself: every surface change is the base engine's.
