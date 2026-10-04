# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly via email:

**security@blescalesync.dev**

Please **do not** open a public GitHub issue for security vulnerabilities.

## What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response

- I will acknowledge your report within **48 hours**
- I will provide a fix or mitigation plan within **7 days**
- Credit will be given in the release notes (unless you prefer to remain anonymous)

## Scope

This policy covers:

- The BLE Scale Sync application (`src/`)
- Docker image and entrypoint
- The Home Assistant add-on (`ble-scale-sync-addon/`, including `run.sh`)
- The ESP32 MQTT proxy firmware (`firmware/`)
- The Garmin Connect helper scripts (`garmin-scripts/`)
- The update-check service at `api.blescalesync.dev` (`worker/`)
- GitHub Actions workflows
- Documentation site (blescalesync.dev)

Out of scope:

- Third-party dependencies (report upstream)
- The Garmin Connect API or other external services
