# Security Policy

## Supported versions

Only the latest released version is supported with security updates.

## Reporting a vulnerability

Please **do not** open a public issue for security-sensitive reports.

Instead, use GitHub private vulnerability reporting (`Security` tab → `Report a vulnerability`) and include:

- impact summary
- reproduction steps / proof of concept
- affected version(s)
- any suggested mitigation

We will acknowledge receipt as quickly as possible, triage severity, and coordinate a fix + disclosure timeline.

## Hardening guidance

`coder` orchestrates LLM agents that execute shell commands. Run it in an isolated environment (VM/container/throwaway devbox) with minimal credentials and no sensitive data.
