# Garuda Express v5 — Vercel Deployment Guide

## 🚀 Deploy to Vercel in 3 Steps

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "Garuda Express v5 — Vercel ready"
git remote add origin https://github.com/YOUR_USERNAME/garuda-express.git
git push -u origin main
```

### Step 2 — Import into Vercel
1. Go to [vercel.com](https://vercel.com) → **Add New Project**
2. Import your GitHub repo
3. Framework preset: **Other**
4. Root Directory: `/` (default)
5. Click **Deploy** — Vercel reads `vercel.json` automatically

### Step 3 — Set Environment Variables
In Vercel Dashboard → **Project Settings** → **Environment Variables**, add:

| Variable | Value |
|---|---|
| `ADMIN_USER` | `admin` |
| `ADMIN_PASS` | your secure password |
| `PORTAL_USER` | `portal` |
| `PORTAL_PASS` | your secure password |
| `TRACK17_API_KEY` | `0E319E804F5FD15912D13A829B6EC143` |
| `DHL_API_KEY` | your DHL key (optional) |
| `FEDEX_API_KEY` | your FedEx key (optional) |
| `FEDEX_API_SECRET` | your FedEx secret (optional) |
| `UPS_CLIENT_ID` | your UPS client ID (optional) |
| `UPS_CLIENT_SECRET` | your UPS secret (optional) |

Redeploy after adding env vars.

---

## ⚠️ Important: Data Persistence

This Vercel version uses **in-memory storage**. Data resets on each cold start (new deployment or idle timeout).

**For production with persistent data**, connect one of:
- **Vercel KV** (Redis) — `npm install @vercel/kv`
- **Neon** (Postgres) — `npm install @neondatabase/serverless`
- **PlanetScale** (MySQL) — `npm install @planetscale/database`

---

## 🔍 Tracking Chain (Fixed)

```
DHL shipment   → DHL Official API   → 17track (with API key) → error
FedEx shipment → FedEx OAuth2 API   → 17track (with API key) → error
UPS shipment   → UPS OAuth2 API     → 17track (with API key) → error
```

**What was broken & fixed:**
- The original 17track "public free endpoint" (no key) only *registers* a tracking number but **never returns events**. It was silently returning empty results.
- Fixed: now properly uses the `TRACK17_API_KEY` to register + fetch events in a single flow.
- Clear error message shown if no API keys are configured at all.

---

## 🌐 URLs After Deployment

| Page | URL |
|---|---|
| Home / Tracking | `https://your-app.vercel.app/` |
| Admin Panel | `https://your-app.vercel.app/Admin` |
| Portal | `https://your-app.vercel.app/portal` |
| Dashboard | `https://your-app.vercel.app/dashboard` |
| Health check | `https://your-app.vercel.app/api/health` |

---

## 🖥️ Running Locally (still works with original server.js)

```bash
npm install
cp .env.example .env   # fill in your values
node server.js         # original Express server with SQLite
```

Or with Vercel CLI:
```bash
npm install -g vercel
vercel dev
```
