// SPDX-License-Identifier: GPL-3.0-or-later

import { randomUUID } from "node:crypto";
import type { Task, TaskState } from "@pi-mesh/protocol";

export const TASK_TTL_MS = 15 * 60 * 1_000;

export interface TaskStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

export class TaskStore {
  private readonly tasks = new Map<string, { task: Task; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: TaskStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? TASK_TTL_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError("Task TTL must be greater than zero");
    }
  }

  create(options: { contextId?: string; state?: TaskState } = {}): Task {
    const task: Task = {
      id: randomUUID(),
      ...(options.contextId === undefined
        ? {}
        : { contextId: options.contextId }),
      status: {
        state: options.state ?? "TASK_STATE_WORKING",
        timestamp: new Date(this.now()).toISOString(),
      },
    };
    this.tasks.set(task.id, { task, expiresAt: this.now() + this.ttlMs });
    return task;
  }

  get(id: string): Task | undefined {
    const entry = this.tasks.get(id);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.tasks.delete(id);
      return undefined;
    }
    return entry.task;
  }

  update(id: string, state: TaskState): Task | undefined {
    const task = this.get(id);
    if (task === undefined) return undefined;
    task.status = {
      ...task.status,
      state,
      timestamp: new Date(this.now()).toISOString(),
    };
    return task;
  }

  cancel(id: string): Task | undefined {
    return this.update(id, "TASK_STATE_CANCELED");
  }

  delete(id: string): boolean {
    return this.tasks.delete(id);
  }

  get size(): number {
    this.prune();
    return this.tasks.size;
  }

  prune(at = this.now()): void {
    for (const [id, entry] of this.tasks) {
      if (entry.expiresAt <= at) this.tasks.delete(id);
    }
  }
}
