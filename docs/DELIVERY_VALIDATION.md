# Delivery validation report

Delivery date: 2026-07-29

## Passed in the delivery environment

The following commands completed successfully:

```bash
npm run check:syntax
npm run check:imports
npm run check:structure
npm run audit:architecture
```

Observed results:

```text
Syntax checked: 59 source files
Relative imports resolved: 59 source files
Structure validated
Architecture audit passed
Solidity source count: exactly 1
Project file count before documentation: 83
Real .env files or private key files detected: none
```

The structure validation specifically confirms:

- the project contains one `VoteEvent.sol` source;
- no V1 access-list, company-token, deployment-registry, or factory contract is present;
- the relayer private key is configured only for the worker in `render.yaml`;
- Snap package and manifest versions are aligned;
- API and indexer source files do not use the V1 contract architecture.

## Not executed in the delivery environment

Dependency installation could not reach `registry.npmjs.org` and failed with DNS error:

```text
EAI_AGAIN
```

Therefore the delivery environment could not execute dependency-backed checks:

```bash
npm run compile
npm run test:contracts
npm run test:shared
npm run build:web
npm run build:snap
npm run check
```

No `node_modules`, generated Hardhat artifact, frontend `dist`, Snap `dist`, or `package-lock.json` is included in the ZIP.

## Required first-run validation

After extracting on a machine with npm registry access, run:

```bash
npm install --include=dev --no-audit --no-fund
npm run check
```

Then commit the generated `package-lock.json` before uploading to GitHub and deploying to Render or Vercel.

## Placeholder configuration intentionally retained

These values must be replaced by the project owner before Snap publication:

```text
apps/snap/package.json npm scope
apps/snap/package.json repository URL
apps/snap/snap.manifest.json npm package name
apps/snap/snap.manifest.json repository URL
apps/snap/snap.manifest.json production allowed origin
```

Use:

```bash
npm run configure:project -- \
  --repository https://github.com/YOUR_USERNAME/mini-galaxy-pv-v2.git \
  --snap-package @YOUR_NPM_SCOPE/pv-communications-snap \
  --origin https://YOUR_VERCEL_DOMAIN
```
