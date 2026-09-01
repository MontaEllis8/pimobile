# Security Policy

## Reporting a vulnerability

PiMobile is a personal-scale project. If you find a security issue, please **do not open a public issue** — report it privately:

- Open a GitHub [security advisory](https://github.com/) (preferred), or
- Email the maintainer (see GitHub profile).

We'll respond as soon as possible. Please include:

- Affected version(s)
- Steps to reproduce
- Impact assessment (what an attacker could do)

## Threat model

PiMobile is designed to be run **on your own machine / trusted LAN**, controlling **your own** Pi agent. Please understand what that means:

- PiMobile's server talks to the [Pi SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) with **full system access**. Anyone who can reach the server can drive your agent — read/write files, run commands, spend your tokens.
- By default the server binds `0.0.0.0:8787` with **no authentication** (`AUTH_TOKEN` empty). On startup it prints an `ERROR`-level banner: `AUTH_TOKEN is empty — server is in OPEN ACCESS mode`. Do **not** expose this to the public internet directly.
- The HTTP file endpoint `GET /files/:id` serves files the AI produced. `id` is a hex-encoded absolute path (not easily guessable) but **has no auth check** in OPEN ACCESS mode — anyone on the LAN who knows the id can download. WS authentication (when enabled) does not yet cover `/files`.

## Recommended hardening

| Scenario | Recommendation |
| --- | --- |
| LAN only (home Wi-Fi, trusted) | OPEN ACCESS is acceptable. Keep the server on your LAN IP, don't port-forward. |
| Remote over the internet | **Do not** port-forward `8787`. Use a private overlay network (Tailscale / ZeroTier / WireGuard) — PiMobile is tested with Tailscale. Or put it behind a reverse proxy (Caddy/nginx) with `AUTH_TOKEN` enforced. |
| AUTH_TOKEN | Set a long random token: `AUTH_TOKEN=your-random-token` on the server, same value in App → Settings → Auth Token. The server checks `Authorization: Bearer <token>` (preferred) or `?token=` fallback. See `.env.example`. |
| /files | If you need stricter file gating, set `AUTH_TOKEN` and ensure your client sends `Authorization` on download (tracked as P2-12). For now treat file ids as short-lived secrets on LAN. |
| Secrets | Never commit `.env`, `*.pem`, `local.properties`, or `*.jks`/`*.keystore`. They are gitignored. |

## Supported versions

Only the latest commit on `main` is actively maintained. There are no formal releases yet.

## Known limitations (accepted for personal-LAN use)

- `/files/:id` without token check (see above) — acceptable on trusted LAN, will be hardened with token header.
- No `wss://` by default — use Tailscale's WireGuard encryption or a reverse proxy with TLS if you need transport encryption.
