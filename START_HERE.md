# Start here

1. Read `README.md` for the system overview.
2. Follow `docs/DEPLOYMENT.md` from section A through Z.
3. Copy `.env.example` to `.env` and `apps/web/.env.local.example` to `apps/web/.env.local`.
4. Run:

```bash
npm install --include=dev --no-audit --no-fund
npm run check:syntax
npm run check:imports
npm run check:structure
npm run audit:architecture
npm run db:migrate
npm run compile
npm run test
npm run build:web
npm run build:snap
```

5. Start API, worker, Snap and web app in separate terminals.
6. Do not deploy until every dependency-backed command passes locally and in GitHub Actions.

The ZIP contains source code only. It intentionally excludes secrets, `node_modules`, build output and generated deployment artifacts.
