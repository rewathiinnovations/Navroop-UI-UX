# Coolify

Create a **Docker Compose** service from this repo’s `docker-compose.yml`. Set environment variables from `.env.example` (names below). Deploy. Git push rebuilds the stack; the app container runs `prisma migrate deploy` then Next.js. No SSH and no manual migrate.

Coolify injects env at runtime. Do not bake secrets into the image.

## Required

| Name | Notes |
| --- | --- |
| `POSTGRES_PASSWORD` | Postgres service password |
| `DATABASE_URL` | `postgresql://navroop:<POSTGRES_PASSWORD>@postgres:5432/navroop` (hostname **`postgres`**, port **5432**) |
| `AUTH_SECRET` | Long random string (NextAuth). `NEXTAUTH_SECRET` is an accepted alias |
| `NEXTAUTH_URL` | Public origin, e.g. `https://your-fqdn` |

Optional aliases: `AUTH_URL`, `NEXTAUTH_SECRET`. Optional first-admin: `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (or `ADMIN_EMAIL` / `ADMIN_PASSWORD`).

## Optional

`POSTGRES_USER`, `POSTGRES_DB` (defaults `navroop`), `PORT` (default `3000`), `NEXT_PUBLIC_WORKSPACE_NAME`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_CALLBACK_URL`, `FIRECRAWL_API_KEY`, `SANDBOX_PROVIDER`, `E2B_API_KEY`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MORPH_API_KEY`, `ENCRYPTION_KEY`.

Local Postgres on host **5433** is `docker-compose.dev.yml` (`pnpm db:up`).
