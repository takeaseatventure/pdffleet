# PDFFleet

**A fast, self-hosted HTML-to-PDF REST API — headless Chromium, API-key auth, usage metering.**

[![Live](https://img.shields.io/badge/status-live-brightgreen)](https://pdffleet.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Live at **[pdffleet.com](https://pdffleet.com)** — 100 free PDFs/month, paid from $4/mo for 10,000.

PDFFleet renders HTML, URLs, and templates to PDF using headless Chromium (Playwright) in a
Docker container. It includes API-key authentication, per-tier rate limiting, monthly usage
metering, and a Stripe-backed billing tier (free / hobby / pro). This repo contains the full
server source so you can self-host it.

## Why?

Incumbent PDF APIs (APITemplate.io, PDFMonkey, DocRaptor) charge $19–$49/mo for
500–3,000 PDFs. PDFFleet renders with the same headless Chromium engine but at a fraction of
the price:

| Tier   | PDFs/month | Price    |
|--------|-----------|----------|
| Free   | 100       | $0       |
| Hobby  | 10,000    | $4/mo    |
| Pro    | 150,000   | $29/mo   |

See the full **[comparison with incumbents →](https://pdffleet.com/#compare)** and the
**[API reference →](https://pdffleet.com/docs)**.

## Quick start

```bash
curl -X POST https://pdffleet.com/v1/pdf \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"html":"<h1>Hello</h1>","options":{"format":"A4"}}' \
  -o output.pdf
```

## Endpoints

| Method | Path           | Description                          |
|--------|----------------|--------------------------------------|
| POST   | `/v1/pdf`      | Render HTML / URL / template → PDF   |
| GET    | `/v1/health`   | Service + browser health (no auth)   |
| GET    | `/v1/usage`    | Current tier, monthly count, quota   |
| POST   | `/v1/keys`     | Create API key (admin only)          |
| GET    | `/v1/keys`     | List API keys (admin only)           |

See **[docs](https://pdffleet.com/docs)** for the full request/response reference.

## Self-hosting

```bash
# Clone and build
docker build -t pdffleet-api .

# Run (Chromium needs --no-sandbox in containers)
docker run -d --name pdffleet \
  -p 8090:8080 \
  -e ADMIN_KEY=your-admin-key \
  -e DATABASE_URL=postgres://... \
  --restart unless-stopped \
  pdffleet-api
```

User data (API keys, usage, templates) is stored in a Postgres database via `DATABASE_URL`.

## Tech stack

- **Node.js** + native HTTP server (zero framework overhead)
- **Playwright** headless Chromium for rendering
- **Docker** image based on `node:20-bookworm-slim` + browser deps
- Static file server for landing/comparison/docs pages

## License

MIT — see [LICENSE](LICENSE).
