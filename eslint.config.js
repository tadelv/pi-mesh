// SPDX-License-Identifier: GPL-3.0-or-later
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Must stay last: turns off rules that would fight the formatter.
  prettier,
);
