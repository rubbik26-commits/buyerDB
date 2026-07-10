# Netlify Runtime Environment Contract

The `buyerdb` Netlify project must use the live SBI Supabase project in every deploy context.

Required public build variables:

- `VITE_API_URL=https://pdvyuepsdnpxctmagdcq.supabase.co`
- `VITE_SUPABASE_ANON_KEY=<Supabase publishable key>`
- `VITE_USE_SUPABASE_RPC=true`

Required serverless-function variables:

- `SUPABASE_URL=https://pdvyuepsdnpxctmagdcq.supabase.co`
- `SUPABASE_PUBLISHABLE_KEY=<Supabase publishable key>`

The same Supabase project reference must be used for production, deploy previews, branch deploys, and local Netlify development. The frontend may contain only the publishable key. Service-role credentials and scraper/provider credentials remain server-side and must never appear in the Vite bundle.

Acceptance:

1. `npm run build` succeeds in RPC mode.
2. The secret-bundle scan succeeds.
3. `api_health()` and the database-backed buyer recommendation contract pass.
4. Netlify deploy preview reaches `ready` with the complete serverless function set.
