# Deploying the Garuda Express backend to Railway

This backend now runs on **SQLite in development** and **PostgreSQL in
production** automatically — see `utils/db.js` for how the switch works.
You don't need to change any code to move from one to the other; it's
driven entirely by whether `DATABASE_URL` is set.

## 1. Local development (unchanged)

```bash
cp .env.example .env      # fill in JWT secrets etc; leave DATABASE_URL blank
npm install
npm run dev
```

This uses SQLite (`db/garuda.db`), created automatically on first boot.

## 2. Deploy to Railway

1. **Create a new Railway project** and connect this `backend/` folder as a
   service (via GitHub repo, or `railway up` from the CLI).
2. **Add a PostgreSQL plugin** to the same Railway project ("+ New" →
   "Database" → "PostgreSQL"). Railway automatically injects a
   `DATABASE_URL` variable into every service in the project — you don't
   need to copy/paste connection strings yourself.
3. **Set the remaining environment variables** under your service's
   "Variables" tab (see `.env.example` for the full list). At minimum for a
   working deploy:
   - `JWT_SECRET`, `JWT_REFRESH_SECRET` — generate with `openssl rand -hex 32`
   - `FRONTEND_URL` — your Vercel frontend URL, e.g. `https://your-app.vercel.app`
   - `NODE_ENV=production`
   - Any OCR/tracking/SMTP keys you're using (all optional — the app degrades
     gracefully with clear "not configured" messages if omitted)
4. **Deploy.** Railway will run `npm install` then `npm start`
   (`node server.js`, see `railway.json`). On first boot the app detects
   `DATABASE_URL`, creates the full Postgres schema, and seeds the default
   admin/employee accounts and RBAC/carrier data automatically — no separate
   migration step needed.
5. Once deployed, copy the Railway-provided public URL (Settings → Networking
   → "Generate Domain") — you'll need it for the frontend's `VITE_API_URL`.

## 3. Important production notes

- **Change the default credentials immediately.** The app seeds
  `GarudaAdmin` / `ExploitEye@2026` (admin) and `Garuda` / `Garuda@2026`
  (employee) on first boot if those accounts don't exist. Override them via
  `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `EMPLOYEE_USERNAME` /
  `EMPLOYEE_PASSWORD` env vars *before* the first deploy, or log in and
  change the passwords immediately after.
- **File uploads are not persisted across deploys.** Railway's filesystem is
  ephemeral — anything written to `uploads/` (OCR'd waybill originals,
  generated waybill PDFs, bulk-upload source files) or `backups/` (the
  retention worker's JSON backups) will be lost on the next deploy/restart.
  For production you should either:
  - Attach a [Railway Volume](https://docs.railway.com/reference/volumes) to
    persist `uploads/` and `backups/`, or
  - Point `original_waybill_file` storage at an external object store (S3,
    Cloudflare R2, etc.) — not wired up yet, would need a small change in
    `routes/shipments.js` and `services/excelImport/index.js`.
- **Webhooks require a public URL.** Once deployed, paste your Railway URL
  + `/api/webhooks/trackingmore` and `/api/webhooks/17track` into each
  tracking provider's dashboard (also shown read-only on the app's Settings
  page) so tracking updates start arriving.
- **CORS**: `FRONTEND_URL` must exactly match your deployed Vercel URL (no
  trailing slash) or the frontend's API calls will be blocked by CORS.

## 4. Verifying the database switch worked

Check your Railway service logs after first deploy — you should see:

```
🔧 Initializing Garuda Express V2.0 schema (Postgres/production)...
✅ Admin account created: GarudaAdmin
✅ Employee account created: Garuda
✅ Garuda Express V2.0 database initialised (Postgres/production)
```

If you instead see `(SQLite/dev)`, `DATABASE_URL` isn't set/visible to the
service — double check the Postgres plugin is attached to the same project
and the variable is present under your service's Variables tab.
