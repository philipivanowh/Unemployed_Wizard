# Unemployed_Wizard

## Setup

Requires **Node.js 23.6+**. Node runs the backend TypeScript directly, so the server has no build step.
The browser code in `src/frontend/` does get compiled, which `npm run dev` and `npm start` do for you.

```sh
npm install
npm run dev        # restarts on file changes, http://localhost:3000
npm start          # builds the frontend, then runs node src/index.ts
npm run typecheck  # Node strips types without checking them, so run this too
```