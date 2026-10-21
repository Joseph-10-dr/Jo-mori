# Deployment

**Status: not deployed.** Nothing has been deployed to staging or production yet. The steps below
identify every external prerequisite; each needs an account only the project owner can create.

## External prerequisites
| Need | Suggested provider | What to obtain | Where it goes |
|---|---|---|---|
| PostgreSQL 16 with PITR backups | Supabase (or Neon/RDS) | Connection string (`sslmode=require`) | `DATABASE_URL` |
| API hosting (Node 22, long-running) | Render / Fly.io / Railway | — | Runs `infrastructure/docker/api.Dockerfile` |
| Dashboard hosting | Vercel (or same host as API) | — | `apps/web`, build env `API_URL=https://api.<domain>` |
| Email | Resend | API key, verified sending domain | `MAIL_PROVIDER=resend`, `RESEND_API_KEY`, `MAIL_FROM` |
| Domain + TLS | Any registrar; TLS from host | DNS records | `PUBLIC_API_URL`, `WEB_ORIGIN` |
| Secrets | Host's secret manager | Generate: `openssl rand -base64 32` (×2) | `TV_DATA_KEY`, `TV_URL_SIGNING_KEY` |
| Error reporting | Sentry (optional) | DSN | Not yet wired in — next step |
| Push notifications | APNs / FCM | Keys | Only needed once mobile apps exist |
| Payments | Paystack/Flutterwave (NG), Stripe | — | Not integrated; billing runs in "no payment" mode |

## Production configuration checklist
- [ ] `NODE_ENV=production` (API refuses to start without keys and with `MAIL_PROVIDER=outbox`)
- [ ] `TV_DATA_KEY`, `TV_URL_SIGNING_KEY` set from the secret manager, backed up securely
- [ ] `DATABASE_URL` with TLS; database user without superuser
- [ ] `PUBLIC_API_URL` / `WEB_ORIGIN` on HTTPS
- [ ] Persistent volume for `STORAGE_DIR` **or** implement the S3/Supabase Storage adapter (recommended before launch)
- [ ] API behind a TLS-terminating proxy (`trust proxy` = 1 hop)
- [ ] Health check on `GET /v1/health`
- [ ] Single API instance until rate limiting uses a shared store
- [ ] Daily PITR backups; restore test performed and documented
- [ ] `BILLING_SELF_SERVE` unset (plan changes then require support)

## Backups and recovery
Enable point-in-time recovery on the managed database (Supabase Pro: 7+ days). Quarterly restore
drill: restore to a scratch database, run `pnpm --filter @tracevault/api db:migrate`, run
`RetentionService.purge`, verify `GET /v1/audit-logs/verify`, then delete the scratch database.
**Restore testing has not yet been performed** — there is no hosted database yet.

## Container images
`infrastructure/docker/api.Dockerfile` and `web.Dockerfile` were written for this deployment but
**could not be built in the development environment** (Docker Hub and ECR rate limits blocked base
image pulls). Build them in CI or locally before relying on them.
