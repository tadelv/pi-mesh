// SPDX-License-Identifier: GPL-3.0-or-later

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRpcClient } from "./rpc.js";
import { resolvePiBinary } from "./spawner.js";

export interface ModelCatalogOptions {
  piBinary?: string;
  ttlMs?: number;
  timeoutMs?: number;
}

export class ModelCatalog {
  private cached?: { models: unknown[]; observedAt: number };
  private flight: Promise<unknown[]> | undefined;
  /** The helper child while one is alive, so shutdown can kill it. */
  private active: PiRpcClient | undefined;
  private closed = false;
  /** Memoised close, so every caller awaits the same completed shutdown. */
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: ModelCatalogOptions = {}) {}

  async get(): Promise<unknown[]> {
    if (this.closed) throw new Error("model catalog helper is closed");
    if (
      this.cached !== undefined &&
      Date.now() - this.cached.observedAt <= (this.options.ttlMs ?? 30_000)
    ) {
      return this.cached.models;
    }
    if (this.flight !== undefined) return this.flight;
    this.flight = this.load();
    try {
      const models = await this.flight;
      this.cached = { models, observedAt: Date.now() };
      return models;
    } finally {
      this.flight = undefined;
    }
  }

  /**
   * Kill an in-flight helper and refuse further ones, so agent shutdown does not
   * leave a `pi --mode rpc` child behind.
   *
   * Without this the helper was only closed when its own request finished, so a
   * `get_available_models` that never answers (a wedged Pi, a stopped machine)
   * outlived the agent. The in-flight promise is awaited only AFTER the child is
   * signalled, because closing it is what makes that promise settle.
   *
   * Memoised: a second call returns the FIRST close promise rather than
   * resolving early, so awaiting any call means the shutdown is actually
   * complete. Without this, `active`/`flight` were read and cleared before the
   * await, and a concurrent second caller returned while the child was still
   * being killed.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.closePromise !== undefined) return this.closePromise;
    const rpc = this.active;
    const flight = this.flight;
    this.active = undefined;
    this.flight = undefined;
    this.closePromise = (async () => {
      await rpc?.close().catch(() => undefined);
      await flight?.catch(() => undefined);
    })();
    return this.closePromise;
  }

  private async load(): Promise<unknown[]> {
    let directory: string | undefined;
    let rpc: PiRpcClient | undefined;
    try {
      if (this.closed) throw new Error("model catalog helper is closed");
      directory = await mkdtemp(join(tmpdir(), "pi-mesh-model-catalog-"));
      // close() can run while the directory is being created. Spawning now would
      // start a child AFTER shutdown, which nothing would then kill - so the
      // check is repeated here, immediately before the spawn.
      if (this.closed) throw new Error("model catalog helper is closed");
      rpc = new PiRpcClient({
        piBinary: resolvePiBinary(this.options.piBinary),
        sessionDir: directory,
        name: "pi-mesh-model-catalog",
        cwd: tmpdir(),
        requestTimeoutMs: this.options.timeoutMs ?? 10_000,
      });
      this.active = rpc;
      // And once more: close() may have run between the check above and this
      // assignment, in which case it captured no child. The finally below closes
      // this one, so throwing here is what keeps the window safe.
      if (this.closed) throw new Error("model catalog helper is closed");
      const response = await rpc.request(
        { type: "get_available_models" },
        this.options.timeoutMs ?? 10_000,
      );
      if (response.success === false) {
        throw new Error("Pi refused get_available_models");
      }
      const data = response.data;
      if (
        typeof data !== "object" ||
        data === null ||
        Array.isArray(data) ||
        !Array.isArray((data as { models?: unknown }).models)
      ) {
        throw new Error("Pi returned an invalid model catalog");
      }
      return (data as { models: unknown[] }).models;
    } finally {
      if (this.active === rpc) this.active = undefined;
      await rpc?.close().catch(() => undefined);
      if (directory !== undefined)
        await rm(directory, { recursive: true, force: true }).catch(
          () => undefined,
        );
    }
  }
}

export function hasExactModel(
  models: readonly unknown[],
  provider: string,
  modelId: string,
): boolean {
  return models.some(
    (model) =>
      typeof model === "object" &&
      model !== null &&
      !Array.isArray(model) &&
      (model as { provider?: unknown }).provider === provider &&
      (model as { id?: unknown }).id === modelId,
  );
}
