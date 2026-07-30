# Validation status

## Source-level checks included

Run:

```bash
npm run check:syntax
npm run check:imports
npm run check:structure
npm run audit:architecture
```

These checks cover:

- parser validation for JavaScript, JSX, TypeScript and TSX source;
- relative-import resolution;
- exactly one Solidity source under `packages/contracts/contracts`;
- absence of V1 factory/registry/company-token/access-list/persona code;
- absence of runtime Hardhat compile/deploy child processes in the API;
- future record-date rejection;
- natural-number token-to-vote ratio validation;
- Render API plus background-worker structure;
- relayer private-key isolation to the worker;
- Snap metadata/package alignment checks;
- required database migrations and transaction outbox.

## Dependency-backed checks

After a successful `npm install`, run:

```bash
npm run compile
npm run test
npm run build:web
npm run build:snap
```

The contract tests cover valid weighted ballots, independent relayers, duplicate rejection, false balances/proofs, altered choices, wrong signer, EIP-712 domain separation, option validation, zero voting power and voting-window enforcement.

The shared tests cover canonical metadata hashing, proposal packing, Merkle proofs, token-unit calculation and typed-ballot recovery.

## Delivery-environment note

During packaging, the npm registry could not be reached from the execution environment (`EAI_AGAIN`). Therefore:

- `package-lock.json` could not be generated;
- Hardhat compile/test could not be executed here;
- Vite and MetaMask Snap production builds could not be executed here;
- `node_modules`, build outputs and generated contract artifacts are intentionally not included.

The source-level checks passed. Run all dependency-backed checks on your machine and in GitHub Actions before deploying.

Static validation is not a smart-contract audit or production-readiness certification.
