# Deploying the Garuda Express frontend to Vercel

## 1. Local development (unchanged)

```bash
cp .env.example .env   # leave VITE_API_URL blank — Vite's dev proxy handles it
npm install
npm run dev
```

Vite's dev server (`vite.config.js`) proxies `/api` and `/uploads` to
`http://localhost:4000`, so you don't need `VITE_API_URL` locally.

## 2. Deploy to Vercel

1. **Import this `frontend/` folder** as a new Vercel project (via the
   Vercel dashboard "Add New Project" → import your Git repo, or
   `vercel --cwd frontend` from the CLI). `vercel.json` is already set up
   with the correct build command, output directory, and an SPA rewrite so
   client-side routes (React Router) don't 404 on refresh.
2. **Set the environment variable** in Vercel → Project Settings →
   Environment Variables:
   - `VITE_API_URL` = your deployed Railway backend URL, **no trailing
     slash**, e.g. `https://your-backend.up.railway.app`
   - `VITE_EMPLOYEE_LOGIN_URL` = your deployed frontend URL (only needed if
     you want the public homepage's login link to point somewhere specific)
3. **Deploy.** Vercel runs `npm install && npm run build` and serves
   `dist/`.
4. Go back to your **Railway backend's** `FRONTEND_URL` variable and set it
   to this Vercel URL, then redeploy the backend — this is what allows CORS
   to accept requests from your frontend.

## 3. Notes

- Since `VITE_API_URL` is baked in at build time (standard for Vite), any
  time you change it you need to trigger a new Vercel deployment for it to
  take effect — just changing the env var in the dashboard isn't enough on
  its own, Vercel does handle this automatically on redeploy/redeploy-with-
  env-changes, but it won't retroactively update an already-built `dist/`.
- If you ever split the public tracking page and the internal admin/employee
  app into two separate Vercel projects, `VITE_EMPLOYEE_LOGIN_URL` is where
  you'd point the public site at the internal one.
