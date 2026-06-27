# PoS‑R Enhanced

PoS‑R Enhanced is a demonstrator implementation of a multi‑dimensional Proof‑of‑Stake with Reputation protocol. The repository contains the smart contracts, deployment scripts, a simulation and analysis pipeline, and a React dashboard for local demos.

## Repository layout

- `contracts/` — Solidity contracts (`ValidatorRegistry.sol`, `StockExchange.sol`).
- `scripts/` — deployment and demo automation (`deploy.js`, `simulation.js`, `analysis.js`, `run_all.sh`, `run_all.ps1`).
- `test/` — Hardhat tests (unit/integration).
- `frontend/` — React + Vite dashboard.
- `csv_exports/` — simulation output CSVs and analysis exports.

## Goals

- Provide a working, local demo of the PoS‑R protocol.
- Enable reproducible experiments via the simulation pipeline.
- Validate core behaviors via an automated test suite and CI.

## Prerequisites

- Node.js 18+ and `npm`.
- `git`.
- Browser with MetaMask (for local UI interaction).

## Quick start (local)

1. Install dependencies:

```bash
npm ci
cd frontend
npm ci
cd ..
```

2. Start a local Hardhat node (terminal A):

```bash
npx hardhat node
```

3. Deploy contracts to the local node (terminal B):

```bash
npm run deploy
```

The deploy script writes `frontend/src/contractAddresses.json` and `frontend/public/contractAddresses.json`.

4. Run the frontend (terminal C):

```bash
cd frontend
npm run dev
# open http://localhost:5173 and connect MetaMask (local network)
```

5. Run simulation / analysis (offline):

```bash
npm run simulate
npm run analyse
```

## Tests

Run contract tests with:

```bash
npm test
```

## CI

A GitHub Actions workflow is provided at `.github/workflows/ci.yml` and performs:

- `npm ci` (root and frontend)
- `npx hardhat compile`
- `npx hardhat test`
- `cd frontend && npm run build`

## Demo automation

- POSIX: `scripts/run_all.sh` — starts a Hardhat node (background), deploys contracts, and builds the frontend.
- Windows: `scripts/run_all.ps1` — PowerShell equivalent.

## Simulation outputs

The simulation exports CSVs and JSON results into `csv_exports/`. Example exports are present; use `scripts/analysis.js` to regenerate or aggregate results.

## License & CONTRIBUTING

- The project is licensed under the MIT License (`LICENSE`).
- Contributor instructions are in `CONTRIBUTING.md`.

## Next steps (pick one)

1. Expand contract tests (edge cases for slashing, collusion thresholds). 
2. Add `solhint` and a security job in CI.
3. Prepare testnet deployment scripts and a short walkthrough.

Reply which item you want next and I will implement it.
