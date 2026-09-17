// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { TaskStore } from "../src/index.js";

describe("TaskStore", () => {
  it("expires tasks at the configured TTL", () => {
    let now = 100;
    const store = new TaskStore({ ttlMs: 10, now: () => now });
    const task = store.create();

    expect(store.get(task.id)).toBe(task);
    now = 110;
    expect(store.get(task.id)).toBeUndefined();
  });

  it("cancels a retained task", () => {
    const store = new TaskStore({ now: () => 100 });
    const task = store.create();

    expect(store.cancel(task.id)?.status.state).toBe("TASK_STATE_CANCELED");
    expect(store.get(task.id)?.status.state).toBe("TASK_STATE_CANCELED");
  });
});
