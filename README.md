# Garuda Express v5 — Production Courier Tracking System

## Quick Start

```bash
# 1. Clone / extract project
cp .env.example .env
nano .env   # fill in your API keys and passwords

# 2. Install Node dependencies
npm install

# 3. Install system OCR tools (required for image-based PDFs like UPS/rotated FedEx)
sudo apt-get install -y tesseract-ocr poppler-utils   # Ubuntu/Debian
# brew install tesseract poppler                       # macOS

# 4. Run
node server.js
# OR with auto-restart on crash:
npm install -g pm2
pm2 start server.js --name garuda-express
pm2 save && pm2 startup
```

Open http://localhost:3000

---

## Routes

| Path | Access | Description |
|------|--------|-------------|
| `/` | Public | Customer tracking page with lorry loader + plane animation |
| `/portal` | Password | Waybill upload portal (password protected) |
| `/Admin` | Password | Admin console |
| `/dashboard` | Admin token | Shipment dashboard |
| `/health` | Public | Server health check JSON |

---

## Tracking API Chain

Each carrier uses **its own dedicated API** first, then falls back to **17track**:

```
DHL shipment   → DHL Official API (api-eu.dhl.com)   → 17track
FedEx shipment → FedEx OAuth2 API (apis.fedex.com)   → 17track  
UPS shipment   → UPS OAuth2 API (onlinetools.ups.com) → 17track
```

17track works **without any API key** (free public endpoint, rate-limited).  
Set `TRACK17_API_KEY` for higher limits.

---

## Waybill PDF Extraction

The portal auto-extracts all fields from uploaded carrier waybills:

| Carrier | Method | Fields Extracted |
|---------|--------|-----------------|
| DHL (text PDF) | pdf-parse | From, To, Tracking No, Weight, Dims, Description, Date |
| FedEx (text PDF) | pdf-parse | From, To, TRK#, Weight, Dims, Description, Service |
| FedEx (image/rotated) | **OCR** (tesseract) | All fields |
| UPS (image PDF) | **OCR** (tesseract) | All fields |

If OCR cannot extract a field, use the **Edit ✏️** button on the portal to fill it in manually.

---

## Essential npm Packages Installed

| Package | Purpose |
|---------|---------|
| `express` | Web framework |
| `better-sqlite3` | Fast embedded database |
| `multer` | File uploads |
| `pdf-parse` | PDF text extraction |
| `dotenv` | Environment config |
| `cors` | Cross-origin headers |
| `helmet` | HTTP security headers |
| `compression` | Gzip response compression |
| `express-rate-limit` | API rate limiting |
| `morgan` | HTTP request logging |
| `winston` | Structured logging to files |
| `node-cron` | Scheduled cache cleanup |
| `nodemon` | Dev auto-restart |

---

## System Dependencies (install on server)

```bash
# OCR (required for image-based PDF waybills)
sudo apt-get install -y tesseract-ocr poppler-utils

# Process manager (optional but recommended for production)
npm install -g pm2

# Nginx reverse proxy (optional, for custom domain + SSL)
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

---

## Default Credentials

| Service | Username | Password | Change via |
|---------|----------|----------|-----------|
| Admin | `admin` | `garuda2024` | `.env` → `ADMIN_USER`, `ADMIN_PASS` |
| Portal | `portal` | `garuda2024` | `.env` → `PORTAL_USER`, `PORTAL_PASS` |

---

## What's New in This Build

1. **Lorry preloader** — Purple animated truck with road, wheels, and Garuda Express branding runs on every page load
2. **Airplane scroll animation** — Garuda purple plane flies across the screen as you scroll, following a wavy flight path with banking/contrail effects
3. **OCR fallback** — Image-based PDFs (UPS labels, rotated FedEx) are now processed via tesseract OCR
4. **Strict API routing** — DHL → DHL API, FedEx → FedEx API, UPS → UPS API (no cross-carrier calls)
5. **Production security** — helmet, compression, rate-limiting, winston logs, cron cache cleanup
6. **Health endpoint** — `GET /health` returns server status JSON
7. **Pieces field** — Waybill shows Weight | Dimensions | Pieces | Ship Date
8. **Portal login wall** — `/portal` is fully password protected with its own credentials
