// SPDX-License-Identifier: GPL-3.0-or-later

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    browserName: "chromium",
    headless: true,
  },
});
