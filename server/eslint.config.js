// ESLint flat config (ESLint 9+) for the Pi Android server.
// QS-07: 只报不拦 — run `npm run lint` to report; not wired into build/commit.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "*.mjs", // integration test scripts (plain Node, out of TS lint scope)
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The codebase intentionally uses `any` for defensive error handling
      // (e.g. `catch (err: any)`) and JSON-typed data. Revisit if desired.
      "@typescript-eslint/no-explicit-any": "off",
      // Warn (not error) on unused vars so the first pass is a report, not a gate.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
