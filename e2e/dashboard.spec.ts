// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, test } from "@playwright/test";
import {
  ControlStore,
  createControlServer,
} from "../packages/control-plane/dist/index.js";

test("dashboard requires its token and connects with it", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Browser Test Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  try {
    const { port } = await control.start();
    const baseURL = `http://127.0.0.1:${port}`;
    const unauthenticated = await browser.newPage();
    await unauthenticated.goto(baseURL);
    await expect(unauthenticated.locator("#auth")).toBeVisible();
    await expect(unauthenticated.locator("#auth-note")).toContainText(
      "Paste the dashboard token to connect",
    );
    const denied = await unauthenticated.evaluate(
      async () => (await fetch("/api/state")).status,
    );
    expect(denied, "dashboard API denies an unauthenticated browser").toBe(401);
    await unauthenticated.close();

    const authenticated = await browser.newPage();
    await authenticated.addInitScript(
      (token) => localStorage.setItem("pi_mesh_token", token),
      store.dashboardToken(),
    );
    await authenticated.goto(baseURL);
    await expect(
      authenticated.getByRole("heading", { name: "Browser Test Control" }),
    ).toBeVisible();
    await expect(authenticated.locator("#auth")).toBeHidden();
    await expect(authenticated.locator("#session-list")).toContainText(
      "No sessions synced yet.",
    );
  } finally {
    try {
      await control.stop();
    } finally {
      store.close();
    }
  }
});

test("selected-session ownership survives out-of-order transcript reads", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Ownership Test Control");
  store.upsertAgent({
    peer_id: "peer-a",
    name: "Agent A",
    host: "127.0.0.1",
    port: 1,
    credential: "fixture-credential",
    paired_at: new Date(0).toISOString(),
  });
  const timestamp = new Date(0).toISOString();
  store.upsertSessions(
    "peer-a",
    [
      {
        id: "session-A",
        project: "/work/a",
        name: "Session A",
        started_at: timestamp,
        updated_at: timestamp,
      },
      {
        id: "session-B",
        project: "/work/b",
        name: "Session B",
        started_at: timestamp,
        updated_at: timestamp,
      },
    ],
    timestamp,
  );
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  const fixtureErrors: string[] = [];
  const token = store.dashboardToken();
  let resolveA!: () => void;
  let resolveB!: () => void;
  let resolveEarlier!: () => void;
  const aGate = new Promise<void>((resolve) => {
    resolveA = resolve;
  });
  const bGate = new Promise<void>((resolve) => {
    resolveB = resolve;
  });
  const earlierGate = new Promise<void>((resolve) => {
    resolveEarlier = resolve;
  });
  try {
    const { port } = await control.start();
    const baseURL = `http://127.0.0.1:${port}`;
    await page.addInitScript(
      (dashboardToken) => localStorage.setItem("pi_mesh_token", dashboardToken),
      token,
    );
    await page.addInitScript(`
      window.__readsSettled = {};
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const url = new URL(response.url);
        const key = url.pathname + url.search;
        if (!url.pathname.startsWith('/api/sessions/')) return response;
        const originalJson = response.json.bind(response);
        response.json = async () => {
          const body = await originalJson();
          setTimeout(() => { window.__readsSettled[key] = (window.__readsSettled[key] || 0) + 1; }, 0);
          return body;
        };
        return response;
      };
    `);
    await page.route("**/api/sessions/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const session = url.pathname.split("/").at(-1);
      const earlierPage =
        session === "session-A" && url.search === "?before=session-A-entry";
      if (
        request.method() !== "GET" ||
        request.headers()["x-pi-mesh-ui"] !== token ||
        !["session-A", "session-B"].includes(session ?? "") ||
        url.pathname !== `/api/sessions/peer-a/${session}` ||
        (url.search !== "" && !earlierPage)
      ) {
        fixtureErrors.push(
          `unexpected session request ${request.method()} ${url.pathname}${url.search}`,
        );
        await route.fulfill({
          status: 400,
          body: "unexpected session request",
        });
        return;
      }
      if (earlierPage) await earlierGate;
      else if (session === "session-A") await aGate;
      else await bGate;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          events: [
            {
              entry_id: earlierPage ? "session-A-older" : `${session}-entry`,
              timestamp,
              data: JSON.stringify({
                type: "message",
                message: {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: earlierPage
                        ? "session-A older page"
                        : `${session} transcript body`,
                    },
                  ],
                },
              }),
            },
          ],
          hasEarlier: session === "session-A" && !earlierPage,
          total: 1,
          all: false,
          stale: false,
        }),
      });
    });
    await page.goto(baseURL);
    await expect(
      page.getByRole("heading", { name: "Ownership Test Control" }),
    ).toBeVisible();
    await expect(page.locator("#session-list")).toContainText("Session A");
    await expect(page.locator("#session-list")).toContainText("Session B");
    const announcement = page.locator("#transcript-status");
    await expect(
      announcement,
      "transcript updates have an announcement role",
    ).toHaveAttribute("role", "status");
    await expect(announcement, "transcript updates are polite").toHaveAttribute(
      "aria-live",
      "polite",
    );
    await expect(
      page.locator("#transcript-panel"),
      "transcript is not announced wholesale",
    ).not.toHaveAttribute("aria-live", /.+/);
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(announcement).toHaveText("Loading session session-A.");
    await page.getByRole("button", { name: /Session B/ }).click();
    await expect(announcement).toHaveText("Loading session session-B.");
    resolveB();
    await expect(
      page.getByRole("heading", { name: "Session B" }),
    ).toBeVisible();
    await expect(page.locator("#transcript-panel")).toContainText(
      "session-B transcript body",
    );
    await expect(announcement).toHaveText("Loaded session session-B.");
    expect(await page.evaluate("document.activeElement?.textContent")).toBe(
      "Session B",
    );
    const staleA = page.waitForResponse((response) =>
      response.url().endsWith("/api/sessions/peer-a/session-A"),
    );
    resolveA();
    await staleA;
    await expect
      .poll(
        () =>
          page.evaluate(
            "window.__readsSettled['/api/sessions/peer-a/session-A'] || 0",
          ),
        { message: "stale A browser continuation has run" },
      )
      .toBe(1);
    await expect(
      page.getByRole("heading", { name: "Session B" }),
      "selected-session ownership keeps B heading after stale A response",
    ).toBeVisible();
    await expect(
      page.locator("#transcript-panel"),
      "selected-session ownership keeps B transcript entry after stale A response",
    ).toContainText("session-B transcript body");
    await expect(
      page.locator("#transcript-panel"),
      "selected-session ownership excludes stale A transcript entry",
    ).not.toContainText("session-A transcript body");
    expect(
      await page.evaluate("document.activeElement?.textContent"),
      "stale session response does not move focus away from selected heading",
    ).toBe("Session B");
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(
      page.getByRole("button", { name: "Load earlier entries" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Load earlier entries" }).click();
    await page.getByRole("button", { name: /Session B/ }).click();
    await expect(
      page.getByRole("heading", { name: "Session B" }),
    ).toBeVisible();
    const staleEarlier = page.waitForResponse((response) =>
      response.url().includes("?before=session-A-entry"),
    );
    resolveEarlier();
    await staleEarlier;
    await expect
      .poll(
        () =>
          page.evaluate(
            "window.__readsSettled['/api/sessions/peer-a/session-A?before=session-A-entry'] || 0",
          ),
        { message: "stale earlier-page browser continuation has run" },
      )
      .toBe(1);
    await expect(
      page.getByRole("heading", { name: "Session B" }),
      "selected-session ownership keeps B heading after stale earlier page",
    ).toBeVisible();
    await expect(
      page.locator("#transcript-panel"),
      "selected-session ownership excludes stale earlier page from B transcript",
    ).not.toContainText("session-A older page");
    await page.getByRole("button", { name: /Session A/ }).click();
    await page.getByRole("button", { name: "Load earlier entries" }).click();
    await expect(page.locator("#transcript-panel")).toContainText(
      "session-A older page",
    );
    await expect(announcement).toHaveText(
      "Earlier entries loaded for session session-A.",
    );
    expect(await page.evaluate("document.activeElement?.textContent")).toBe(
      "Session A",
    );
    expect(
      fixtureErrors,
      "browser transcript fixture rejects unexpected route shape and requires token",
    ).toEqual([]);
  } finally {
    resolveA();
    resolveB();
    resolveEarlier();
    await page.close();
    try {
      await control.stop();
    } finally {
      store.close();
    }
  }
});

test("session prompt sends only an explicit eligible job and keeps owner-scoped drafts", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Prompt Submission Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  const token = store.dashboardToken();
  const fixtureErrors: string[] = [];
  const posts: Array<{ peer: string; body: unknown }> = [];
  const timestamp = new Date(0).toISOString();
  let mode = "single";
  let observation = "append";
  let transcriptReads = 0;
  let transcriptEvents = [
    {
      entry_id: "baseline-entry",
      timestamp,
      data: JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Existing turn" }],
        },
      }),
    },
  ];
  let resolvePending!: () => void;
  let resolveReselect!: () => void;
  let resolveExact!: () => void;
  const pendingGate = new Promise<void>((resolve) => {
    resolvePending = resolve;
  });
  const reselectGate = new Promise<void>((resolve) => {
    resolveReselect = resolve;
  });
  const exactGate = new Promise<void>((resolve) => {
    resolveExact = resolve;
  });
  const jobs = [
    {
      agent_id: "peer-a",
      job_id: "job-a",
      session_id: "session-a",
      pid: 123,
      project: "/work/a",
      created_at: timestamp,
      state: "running",
    },
    {
      agent_id: "peer-a",
      job_id: "job-b",
      session_id: "session-a",
      pid: 456,
      project: "/work/a-two",
      created_at: timestamp,
      state: "running",
    },
  ];
  try {
    const { port } = await control.start();
    const baseURL = `http://127.0.0.1:${port}`;
    await page.addInitScript(
      (dashboardToken) => localStorage.setItem("pi_mesh_token", dashboardToken),
      token,
    );
    // Mark completion after the browser's POST JSON await continuation, not
    // merely after the intercepted HTTP response becomes available.
    await page.clock.install();
    await page.addInitScript(`
      window.__steerSettled = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (!new URL(response.url).pathname.endsWith('/steer')) return response;
        const message = JSON.parse(args[1].body).message;
        const originalJson = response.json.bind(response);
        response.json = async () => {
          const body = await originalJson();
          setTimeout(() => window.__steerSettled.push(message), 0);
          return body;
        };
        return response;
      };
    `);
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const expectedHeader = request.headers()["x-pi-mesh-ui"] === token;
      if (
        url.pathname === "/api/state" &&
        request.method() === "GET" &&
        expectedHeader &&
        request.postData() === null
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: { id: "control-a", name: "Prompt Submission Control" },
            agents: [
              {
                peer_id: "peer-a",
                name: "Agent A",
                host: "127.0.0.1",
                port: 7330,
                paired_at: timestamp,
                skills: ["session.steer"],
                controls: {
                  spawn: false,
                  steer: true,
                  stop: false,
                  abort: false,
                },
                jobs_synced_at: 1,
              },
            ],
            sessions: ["session-a", "session-b"].map((id) => ({
              agent_id: "peer-a",
              session_id: id,
              project: "/work/a",
              name: id === "session-a" ? "Session A" : "Session B",
              started_at: timestamp,
              updated_at: timestamp,
              synced_at: timestamp,
            })),
            jobs: [
              ...(mode === "multiple" ? jobs : [jobs[0]]),
              { ...jobs[0], job_id: "job-session-b", session_id: "session-b" },
            ],
            execution_transport: "confidential",
          }),
        });
        return;
      }
      const sessionMatch = url.pathname.match(
        /^\/api\/sessions\/peer-a\/(session-a|session-b)$/,
      );
      if (
        sessionMatch &&
        request.method() === "GET" &&
        expectedHeader &&
        request.postData() === null &&
        url.search === ""
      ) {
        if (sessionMatch[1] === "session-a") transcriptReads++;
        const events =
          sessionMatch[1] === "session-a"
            ? transcriptEvents
            : [
                {
                  entry_id: "session-b-baseline",
                  timestamp,
                  data: JSON.stringify({
                    type: "message",
                    message: {
                      role: "user",
                      content: [{ type: "text", text: "B existing turn" }],
                    },
                  }),
                },
              ];
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            events: events.slice(-200),
            hasEarlier: events.length > 200,
            total: events.length,
            all: false,
            stale: observation === "stale" && sessionMatch[1] === "session-a",
          }),
        });
        return;
      }
      const steerMatch = url.pathname.match(/^\/api\/agents\/(peer-a)\/steer$/);
      if (
        steerMatch &&
        request.method() === "POST" &&
        expectedHeader &&
        request.headers()["content-type"] === "application/json"
      ) {
        const body = request.postDataJSON() as {
          job_id?: string;
          message?: string;
        };
        const validJobs = mode === "multiple" ? ["job-a", "job-b"] : ["job-a"];
        if (
          Object.keys(body).sort().join(",") !== "job_id,message" ||
          !validJobs.includes(body.job_id ?? "") ||
          typeof body.message !== "string"
        ) {
          fixtureErrors.push(`invalid steer body ${JSON.stringify(body)}`);
          await route.fulfill({ status: 400, body: "invalid steer body" });
          return;
        }
        posts.push({ peer: steerMatch[1]!, body });
        if (body.message === "pending A") await pendingGate;
        if (body.message === "pending again") await reselectGate;
        if (body.message === "exact prompt") await exactGate;
        if (body.message === "agent refuses") {
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              code: -32102,
              message: "Execution is not enabled",
            }),
          });
        } else if (body.message === "transport refuses") {
          await route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ error: "confidential_transport_required" }),
          });
        } else if (body.message === "agent call fails") {
          await route.fulfill({
            status: 502,
            contentType: "application/json",
            body: JSON.stringify({ error: "agent_unreachable" }),
          });
        } else {
          if (observation !== "none") {
            // Deliberately model an indistinguishable competing writer: entries
            // contain no request/job origin, even for an exact text match.
            transcriptEvents = [
              ...transcriptEvents,
              {
                entry_id: `turn-${transcriptEvents.length}`,
                timestamp,
                data: JSON.stringify({
                  type: "message",
                  message: {
                    role: "user",
                    content:
                      body.message === "exact prompt"
                        ? body.message
                        : [{ type: "text", text: body.message }],
                  },
                }),
              },
            ];
            if (observation === "overrun") {
              transcriptEvents = [
                ...transcriptEvents,
                ...Array.from({ length: 201 }, (_, i) => ({
                  entry_id: `overflow-${i}`,
                  timestamp,
                  data: JSON.stringify({
                    type: "message",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: `Unrelated ${i}` }],
                    },
                  }),
                })),
              ];
            }
          }
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
        }
        return;
      }
      fixtureErrors.push(
        `unexpected request ${request.method()} ${url.pathname}${url.search}`,
      );
      await route.fulfill({
        status: 400,
        body: "unexpected dashboard request",
      });
    });
    await page.goto(baseURL);
    await expect(
      page.getByRole("heading", { name: "Prompt Submission Control" }),
    ).toBeVisible();
    async function selectSession(name: string) {
      await page.getByRole("button", { name: new RegExp(name) }).click();
      await expect(
        page.getByRole("heading", { name: "Prompt this session" }),
      ).toBeVisible();
    }
    await selectSession("Session A");
    const composer = page.getByRole("textbox", { name: "Message to session" });
    await composer.fill("exact prompt");
    const send = page.getByRole("button", { name: "Send" });
    await page.locator("#transcript-panel form").evaluate((form) => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await expect
      .poll(
        () =>
          posts.filter(
            ({ body }) =>
              (body as { message?: string }).message === "exact prompt",
          ).length,
      )
      .toBe(1);
    expect(
      posts,
      "duplicate submission is blocked synchronously while the request is pending",
    ).toEqual([
      { peer: "peer-a", body: { job_id: "job-a", message: "exact prompt" } },
    ]);
    resolveExact();
    await expect(page.locator("#transcript-panel")).toContainText(
      "Accepted; checking transcript.",
    );
    await expect(
      page.locator("#transcript-panel"),
      "an appended plain-string user turn confirms the nonempty baseline without proving attribution",
    ).toContainText(
      "Matching turn observed in this session; origin not verified.",
    );
    await expect(page.locator("#transcript-panel")).toContainText(
      "Existing turn",
    );
    await expect(page.locator("#transcript-panel")).toContainText(
      "exact prompt",
    );
    await expect(composer).toHaveValue("");
    await expect(
      page.locator("#transcript-panel [role='status']"),
      "short composer outcome is an announcement, not the whole transcript",
    ).toContainText("origin not verified");
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
        expect(
          await page.evaluate(
            "document.documentElement.scrollWidth <= window.innerWidth",
          ),
          `${width}px ${colorScheme} layout has no horizontal overflow`,
        ).toBe(true);
        await expect(page.locator(".entry").first()).toHaveCSS(
          "animation-name",
          "none",
        );
      }
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.emulateMedia({
      colorScheme: "light",
      reducedMotion: "no-preference",
    });
    observation = "none";
    await composer.fill("switch after acceptance");
    await send.click();
    await expect(page.locator("#transcript-panel")).toContainText(
      "Accepted; checking transcript.",
    );
    await selectSession("Session B");
    await page.clock.runFor(1_200);
    await expect(
      page.locator("#transcript-panel"),
      "A observation outcome never appears in B",
    ).not.toContainText("Accepted;");
    await expect(page.locator("#transcript-panel")).toContainText(
      "B existing turn",
    );
    await selectSession("Session A");
    await expect(
      page.locator("#transcript-panel"),
      "switch after acceptance ends observation honestly for A",
    ).toContainText(
      "Accepted; observation interrupted by session switch. Delivery is unconfirmed.",
    );
    await expect(composer).toHaveValue("switch after acceptance");
    const readsBefore = transcriptReads;
    await composer.fill("unobserved turn");
    await send.click();
    await expect(page.locator("#transcript-panel")).toContainText(
      "Accepted; checking transcript.",
    );
    // A single 16-second fake-clock jump can run the first timer at the
    // deadline, skipping every fetch. Prove an early read before expiry.
    await page.clock.runFor(1_100);
    await expect
      .poll(() => transcriptReads - readsBefore, {
        message: "observation fetches at least once before the deadline",
      })
      .toBeGreaterThan(0);
    await page.clock.runFor(16_000);
    await expect(
      page.locator("#transcript-panel"),
      "15-second bounded no-turn result is unconfirmed",
    ).toContainText(
      "Accepted, but no new turn was observed. Delivery is unconfirmed.",
    );
    await expect(composer, "an unconfirmed draft is retained").toHaveValue(
      "unobserved turn",
    );
    expect(
      transcriptReads - readsBefore,
      "observation reads are bounded",
    ).toBeGreaterThan(0);
    expect(
      transcriptReads - readsBefore,
      "observation reads are bounded",
    ).toBeLessThanOrEqual(15);
    expect(
      posts.filter(
        ({ body }) =>
          (body as { message?: string }).message === "unobserved turn",
      ),
    ).toHaveLength(1);

    observation = "overrun";
    await composer.fill("overflowed turn");
    await send.click();
    await expect(page.locator("#transcript-panel")).toContainText(
      "Accepted; checking transcript.",
    );
    await page.clock.runFor(16_000);
    await expect(
      page.locator("#transcript-panel"),
      "200-entry tail overrun remains unconfirmed, never not delivered",
    ).toContainText("Delivery is unconfirmed.");
    await expect(composer).toHaveValue("overflowed turn");
    observation = "stale";
    await composer.fill("cached matching turn");
    await send.click();
    await expect(
      page.locator("#transcript-status"),
      "a stale matching entry is not proof of an observed turn",
    ).toContainText(
      "the transcript could not be verified. Delivery is unconfirmed.",
    );
    await expect(page.locator("#transcript-panel")).toContainText(
      "Prompting is unavailable until this transcript is verified with the agent.",
    );
    await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
    observation = "append";
    await selectSession("Session A");
    await expect(
      composer,
      "the stale-read refusal retains the draft",
    ).toHaveValue("cached matching turn");
    await composer.fill("agent refuses");
    await send.click();
    await expect(page.locator("#transcript-panel")).toContainText(
      "Agent refusal (-32102): Execution is not enabled",
    );
    await expect(
      page.getByRole("textbox", { name: "Message to session" }),
    ).toHaveValue("agent refuses");
    await page
      .getByRole("textbox", { name: "Message to session" })
      .fill("agent call fails");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("#transcript-panel")).toContainText(
      "Agent call failed (502): agent_unreachable",
    );
    await expect(
      page.getByRole("textbox", { name: "Message to session" }),
    ).toHaveValue("agent call fails");
    await page
      .getByRole("textbox", { name: "Message to session" })
      .fill("transport refuses");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("#transcript-panel")).toContainText(
      "Control-plane transport refusal: confidential_transport_required.",
    );
    await expect(
      page.getByRole("textbox", { name: "Message to session" }),
    ).toHaveValue("transport refuses");

    await page
      .getByRole("textbox", { name: "Message to session" })
      .fill("pending A");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("#transcript-panel")).toContainText(
      "Sending to agent",
    );
    await selectSession("Session B");
    await expect(
      page.getByRole("textbox", { name: "Message to session" }),
      "A draft does not appear in B",
    ).toHaveValue("");
    resolvePending();
    await expect
      .poll(
        () => page.evaluate("window.__steerSettled.includes('pending A')"),
        { message: "A POST continuation finished after selecting B" },
      )
      .toBe(true);
    await expect(
      page.locator("#transcript-panel"),
      "A completion does not appear in B",
    ).not.toContainText("Accepted;");
    await expect(
      page.getByRole("textbox", { name: "Message to session" }),
      "B draft stays empty after A completes",
    ).toHaveValue("");
    await expect(
      page.getByRole("heading", { name: "Session B" }),
    ).toBeVisible();

    await selectSession("Session A");
    await expect(
      page.locator("#transcript-panel"),
      "a switched pending POST belongs to A and leaves delivery unconfirmed",
    ).toContainText(
      "Accepted; observation interrupted by session switch. Delivery is unconfirmed.",
    );
    await page
      .getByRole("textbox", { name: "Message to session" })
      .fill("pending again");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("#transcript-panel")).toContainText(
      "Sending to agent",
    );
    await selectSession("Session B");
    await selectSession("Session A");
    await expect(
      page.getByRole("textbox", { name: "Message to session" }),
    ).toHaveValue("pending again");
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    resolveReselect();
    await expect
      .poll(
        () => page.evaluate("window.__steerSettled.includes('pending again')"),
        { message: "pending A POST completed after A was reselected" },
      )
      .toBe(true);
    await expect(
      page.locator("#transcript-panel"),
      "A->B->A completion unlocks A with an honest interrupted outcome",
    ).toContainText(
      "Accepted; observation interrupted by session switch. Delivery is unconfirmed.",
    );
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    mode = "multiple";
    await page.reload();
    await selectSession("Session A");
    await expect(page.locator("#transcript-panel")).toContainText(
      "More than one job claims this session. Choose which job to prompt.",
    );
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await page.getByLabel("Choose a job").selectOption("job-b");
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await page.getByLabel("I chose this job intentionally").check();
    await expect(
      page.getByRole("button", { name: "Send" }),
      "choosing a job without a message cannot send",
    ).toBeDisabled();
    await page
      .getByRole("textbox", { name: "Message to session" })
      .fill("chosen explicit job");
    await selectSession("Session B");
    await selectSession("Session A");
    await expect(
      page.getByRole("textbox", { name: "Message to session" }),
      "session switch keeps draft",
    ).toHaveValue("chosen explicit job");
    await expect(
      page.getByLabel("Choose a job"),
      "session switch clears job choice",
    ).toHaveValue("");
    await expect(
      page.getByLabel("I chose this job intentionally"),
      "session switch clears confirmation",
    ).not.toBeChecked();
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await page.getByLabel("Choose a job").selectOption("job-b");
    await page.getByLabel("I chose this job intentionally").check();
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("#transcript-panel")).toContainText(
      "Matching turn observed in this session; origin not verified.",
    );
    expect(
      posts.at(-1),
      "ambiguous jobs require and use the explicitly confirmed choice",
    ).toEqual({
      peer: "peer-a",
      body: { job_id: "job-b", message: "chosen explicit job" },
    });
    const exact = "é".repeat(2048);
    await page.getByRole("textbox", { name: "Message to session" }).fill(exact);
    await expect(page.locator("#transcript-panel")).toContainText(
      "4096 / 4096 bytes",
    );
    await expect(
      page.getByRole("button", { name: "Send" }),
      "exact 4096 UTF-8 bytes are allowed",
    ).toBeEnabled();
    await page.getByRole("button", { name: "Send" }).click();
    await expect
      .poll(
        () =>
          posts.filter(
            ({ body }) => (body as { message?: string }).message === exact,
          ).length,
      )
      .toBe(1);
    const multibyte = "é".repeat(2049);
    await page
      .getByRole("textbox", { name: "Message to session" })
      .fill(multibyte);
    await expect(page.locator("#transcript-panel")).toContainText(
      "4098 / 4096 bytes",
    );
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(
      posts.some(
        ({ body }) => (body as { message?: string }).message === multibyte,
      ),
      "UTF-8 oversized message is never sent",
    ).toBe(false);
    expect(
      fixtureErrors,
      "strict prompt fixture rejects every incorrect API shape",
    ).toEqual([]);
  } finally {
    resolvePending();
    resolveReselect();
    resolveExact();
    await page.close();
    try {
      await control.stop();
    } finally {
      store.close();
    }
  }
});

test("prompt availability follows transcript and live-job evidence", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Prompt Availability Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  const token = store.dashboardToken();
  const fixtureErrors: string[] = [];
  const timestamp = new Date(0).toISOString();
  let scenario = "cached";
  const job = {
    agent_id: "peer-a",
    job_id: "job-a",
    session_id: "session-a",
    pid: 123,
    project: "/work/a",
    created_at: timestamp,
    state: "running",
  };
  const session = {
    agent_id: "peer-a",
    session_id: "session-a",
    project: "/work/a",
    name: "Session A",
    started_at: timestamp,
    updated_at: timestamp,
    synced_at: timestamp,
  };
  try {
    const { port } = await control.start();
    const baseURL = `http://127.0.0.1:${port}`;
    await page.addInitScript(
      (dashboardToken) => localStorage.setItem("pi_mesh_token", dashboardToken),
      token,
    );
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        request.method() !== "GET" ||
        request.headers()["x-pi-mesh-ui"] !== token ||
        request.postData() !== null ||
        (url.search !== "" &&
          !(
            scenario === "earlier-stale" &&
            url.pathname === "/api/sessions/peer-a/session-a" &&
            url.search === "?before=session-a-entry"
          )) ||
        !["/api/state", "/api/sessions/peer-a/session-a"].includes(url.pathname)
      ) {
        fixtureErrors.push(
          `unexpected request ${request.method()} ${url.pathname}${url.search}`,
        );
        await route.fulfill({
          status: 400,
          body: "unexpected dashboard request",
        });
        return;
      }
      if (url.pathname === "/api/state") {
        const freshness = scenario === "cached" ? null : 1;
        const skills =
          scenario === "unknown"
            ? null
            : scenario === "disabled"
              ? []
              : ["session.steer"];
        const jobs =
          scenario === "none"
            ? []
            : scenario === "exited"
              ? [{ ...job, state: "exited" }]
              : scenario === "multiple"
                ? [job, { ...job, job_id: "job-b", pid: 456 }]
                : scenario === "wrong-agent"
                  ? [{ ...job, agent_id: "peer-b" }]
                  : scenario === "wrong-session"
                    ? [{ ...job, session_id: "session-b" }]
                    : [job];
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: { id: "control-a", name: "Prompt Availability Control" },
            agents: [
              {
                peer_id: "peer-a",
                name: "Agent A",
                host: "127.0.0.1",
                port: 7330,
                paired_at: timestamp,
                skills,
                controls: {
                  spawn: false,
                  steer: skills?.includes("session.steer") ?? false,
                  stop: false,
                  abort: false,
                },
                jobs_synced_at: freshness,
              },
            ],
            sessions: [session],
            jobs,
            execution_transport:
              scenario === "transport" ? "refused" : "confidential",
          }),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          events:
            scenario === "earlier-stale" && !url.search
              ? [
                  {
                    entry_id: "session-a-entry",
                    timestamp,
                    data: JSON.stringify({
                      type: "message",
                      message: {
                        role: "user",
                        content: [{ type: "text", text: "Initial entry" }],
                      },
                    }),
                  },
                ]
              : [],
          hasEarlier: scenario === "earlier-stale" && !url.search,
          total: scenario === "earlier-stale" ? 1 : 0,
          all: false,
          stale:
            scenario === "stale" ||
            (scenario === "earlier-stale" && !!url.search),
        }),
      });
    });
    await page.goto(baseURL);
    await expect(
      page.getByRole("heading", { name: "Prompt Availability Control" }),
    ).toBeVisible();
    async function select(next: string) {
      scenario = next;
      await page.reload();
      await page.getByRole("button", { name: /Session A/ }).click();
      await expect(
        page.getByRole("heading", { name: "Prompt this session" }),
      ).toBeVisible();
    }
    const prompt = page.locator("#transcript-panel");
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(
      prompt,
      "cached-job freshness clause refuses an unsynced running job",
    ).toContainText(
      "Jobs have not been confirmed with this agent. Sync to check before prompting.",
    );
    await expect(page.locator("#agents")).toContainText("job-a");
    await expect(prompt).not.toContainText("Ready to prompt this session.");
    await expect(prompt).not.toContainText("Send");
    await expect(page.locator("#agents")).not.toContainText("Steer ");
    await select("stale");
    await expect(prompt).toContainText(
      "This transcript could not be verified with the agent; showing cached entries.",
    );
    await expect(prompt).toContainText(
      "Prompting is unavailable until this transcript is verified with the agent.",
    );
    await expect(
      prompt,
      "failed transcript read is not called offline",
    ).not.toContainText("agent offline");
    await select("earlier-stale");
    await expect(
      prompt.getByRole("textbox", { name: "Message to session" }),
    ).toBeVisible();
    await expect(prompt).not.toContainText("Ready to prompt this session.");
    await page.getByRole("button", { name: "Load earlier entries" }).click();
    await expect(
      prompt,
      "failed earlier-page read withdraws prompt readiness",
    ).toContainText(
      "Prompting is unavailable until this transcript is verified with the agent.",
    );
    await expect(prompt).not.toContainText("Ready to prompt this session.");
    await select("unknown");
    await expect(prompt).toContainText("Steering capability is unknown");
    await select("disabled");
    await expect(prompt).toContainText(
      "This agent has not enabled steering for this control plane.",
    );
    await select("none");
    await expect(prompt).toContainText("No job is running for this session.");
    await select("exited");
    await expect(prompt).toContainText(
      "The job for this session is no longer running.",
    );
    await select("transport");
    await expect(prompt).toContainText(
      "Prompting requires TLS or loopback on this connection.",
    );
    await select("wrong-agent");
    await expect(
      prompt,
      "another agent's job cannot make this session ready",
    ).toContainText("No job is running for this session.");
    await expect(prompt).not.toContainText("Ready to prompt this session.");
    await select("wrong-session");
    await expect(
      prompt,
      "another session's job cannot make this session ready",
    ).toContainText("No job is running for this session.");
    await expect(prompt).not.toContainText("Ready to prompt this session.");
    await select("multiple");
    await expect(prompt).toContainText(
      "More than one job claims this session. Choose which job to prompt.",
    );
    await expect(prompt).toContainText("job-a · PID 123 · /work/a");
    await expect(prompt).toContainText("job-b · PID 456 · /work/a");
    await select("ready");
    await expect(
      prompt.getByRole("textbox", { name: "Message to session" }),
    ).toBeVisible();
    await expect(prompt).not.toContainText("Ready to prompt this session.");
    expect(
      fixtureErrors,
      "prompt availability fixture enforces exact API method, path, query, and auth header",
    ).toEqual([]);
  } finally {
    try {
      await control.stop();
    } finally {
      await page.close();
      store.close();
    }
  }
});

test("prompt command hints come from the running job's Pi and never promise execution", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Command Hints Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  const token = store.dashboardToken();
  const timestamp = new Date(0).toISOString();
  const steers: Array<Record<string, unknown>> = [];
  try {
    const { port } = await control.start();
    const baseURL = `http://127.0.0.1:${port}`;
    await page.addInitScript(
      (t) => localStorage.setItem("pi_mesh_token", t),
      token,
    );
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const ok = request.headers()["x-pi-mesh-ui"] === token;
      if (url.pathname === "/api/state" && request.method() === "GET" && ok) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: { id: "control-hints", name: "Command Hints Control" },
            agents: [
              {
                peer_id: "peer-a",
                name: "Agent A",
                host: "127.0.0.1",
                port: 7330,
                paired_at: timestamp,
                skills: ["session.steer", "session.commands"],
                controls: {
                  spawn: false,
                  steer: true,
                  stop: false,
                  abort: false,
                  commands: true,
                },
                jobs_synced_at: 1,
              },
            ],
            sessions: [
              {
                agent_id: "peer-a",
                session_id: "session-a",
                project: "/work/a",
                name: "Session A",
                started_at: timestamp,
                updated_at: timestamp,
                synced_at: timestamp,
              },
            ],
            jobs: [
              {
                agent_id: "peer-a",
                job_id: "job-a",
                session_id: "session-a",
                pid: 11,
                project: "/work/a",
                created_at: timestamp,
                state: "running",
              },
            ],
            execution_transport: "confidential",
          }),
        });
        return;
      }
      if (
        url.pathname === "/api/sessions/peer-a/session-a" &&
        request.method() === "GET" &&
        url.search === "" &&
        ok
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            events: [
              {
                entry_id: "e1",
                timestamp,
                data: JSON.stringify({
                  type: "message",
                  message: {
                    role: "user",
                    content: [{ type: "text", text: "hello" }],
                  },
                }),
              },
            ],
            hasEarlier: false,
            total: 1,
            all: false,
            stale: false,
          }),
        });
        return;
      }
      if (
        url.pathname === "/api/agents/peer-a/commands" &&
        request.method() === "GET" &&
        ok
      ) {
        expect(
          url.searchParams.get("job_id"),
          "the commands read names the running job",
        ).toBe("job-a");
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            commands: [
              {
                name: "fix-tests",
                description: "Fix failing tests",
                source: "prompt",
              },
              {
                name: "skill:deploy",
                description: "Deploy the service",
                source: "skill",
              },
            ],
          }),
        });
        return;
      }
      if (
        url.pathname === "/api/agents/peer-a/steer" &&
        request.method() === "POST" &&
        ok
      ) {
        steers.push(request.postDataJSON() as Record<string, unknown>);
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }
      await route.fulfill({ status: 400, body: "unexpected request" });
    });
    await page.goto(baseURL);
    await expect(
      page.getByRole("heading", { name: "Command Hints Control" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(
      page.getByRole("heading", { name: "Prompt this session" }),
    ).toBeVisible();
    const card = page.locator("#transcript-panel");
    await expect(
      card,
      "the reported names are listed WITH their descriptions",
    ).toContainText("/fix-tests");
    await expect(card).toContainText("Fix failing tests");
    await expect(card).toContainText("/skill:deploy");
    await expect(card).toContainText("Deploy the service");
    const composer = page.getByRole("textbox", { name: "Message to session" });
    // Functional completion: a textarea does not honor `list`, so choosing a
    // reported command must insert it into the draft.
    await composer.fill("");
    await page.getByLabel("Insert a command").selectOption("/skill:deploy");
    await expect(
      composer,
      "a chosen command is inserted into the draft",
    ).toHaveValue(/\/skill:deploy/);
    await composer.fill("/skill:deploy now");
    await expect(card).toContainText(
      "Deploy the service (advisory; sent to Pi as text)",
    );
    await composer.fill("/model sonnet");
    await expect(card).toContainText("TUI-only built-in");
    await composer.fill("/nope");
    await expect(card).toContainText("not in this Pi's reported commands");
    // An unknown name is neither blocked nor rewritten: it is sent verbatim.
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => steers.length).toBe(1);
    expect(
      steers[0],
      "an unknown command name is sent verbatim through session.steer, not blocked",
    ).toEqual({ job_id: "job-a", message: "/nope" });
  } finally {
    await page.close();
    await control.stop();
    store.close();
  }
});

test("a TUI-only command is explained even when the agent does not advertise session.commands", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("No Command Hints Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  const token = store.dashboardToken();
  const timestamp = new Date(0).toISOString();
  let commandRequests = 0;
  try {
    const { port } = await control.start();
    const baseURL = `http://127.0.0.1:${port}`;
    await page.addInitScript(
      (t) => localStorage.setItem("pi_mesh_token", t),
      token,
    );
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const ok = request.headers()["x-pi-mesh-ui"] === token;
      if (url.pathname.endsWith("/commands")) commandRequests += 1;
      if (url.pathname === "/api/state" && request.method() === "GET" && ok) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: { id: "control-nocmd", name: "No Command Hints Control" },
            agents: [
              {
                peer_id: "peer-a",
                name: "Agent A",
                host: "127.0.0.1",
                port: 7330,
                paired_at: timestamp,
                skills: ["session.steer"],
                controls: {
                  spawn: false,
                  steer: true,
                  stop: false,
                  abort: false,
                  commands: false,
                },
                jobs_synced_at: 1,
              },
            ],
            sessions: [
              {
                agent_id: "peer-a",
                session_id: "session-a",
                project: "/work/a",
                name: "Session A",
                started_at: timestamp,
                updated_at: timestamp,
                synced_at: timestamp,
              },
            ],
            jobs: [
              {
                agent_id: "peer-a",
                job_id: "job-a",
                session_id: "session-a",
                pid: 11,
                project: "/work/a",
                created_at: timestamp,
                state: "running",
              },
            ],
            execution_transport: "confidential",
          }),
        });
        return;
      }
      if (
        url.pathname === "/api/sessions/peer-a/session-a" &&
        request.method() === "GET" &&
        url.search === "" &&
        ok
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            events: [
              {
                entry_id: "e1",
                timestamp,
                data: JSON.stringify({
                  type: "message",
                  message: {
                    role: "user",
                    content: [{ type: "text", text: "hello" }],
                  },
                }),
              },
            ],
            hasEarlier: false,
            total: 1,
            all: false,
            stale: false,
          }),
        });
        return;
      }
      // No /commands route: this agent does not advertise the skill, so the card
      // must not ask for it. A request here would 400 and fail the test.
      await route.fulfill({ status: 400, body: "unexpected request" });
    });
    await page.goto(baseURL);
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(
      page.getByRole("heading", { name: "Prompt this session" }),
    ).toBeVisible();
    const card = page.locator("#transcript-panel");
    const composer = page.getByRole("textbox", { name: "Message to session" });
    await composer.fill("/model sonnet");
    await expect(
      card,
      "a TUI-only built-in is explained even without command hints",
    ).toContainText("TUI-only built-in");
    await composer.fill("/nope");
    await expect(card).toContainText("command hints are unavailable");
    expect(
      commandRequests,
      "an agent that does not advertise session.commands must never be asked for its commands",
    ).toBe(0);
  } finally {
    await page.close();
    await control.stop();
    store.close();
  }
});

test("command hints follow the selected job when several claim the session", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Multi-job Command Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  const token = store.dashboardToken();
  const timestamp = new Date(0).toISOString();
  let releaseAlpha!: () => void;
  const alphaHeld = new Promise<void>((resolve) => {
    releaseAlpha = resolve;
  });
  try {
    const { port } = await control.start();
    const baseURL = `http://127.0.0.1:${port}`;
    await page.addInitScript(
      (t) => localStorage.setItem("pi_mesh_token", t),
      token,
    );
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const ok = request.headers()["x-pi-mesh-ui"] === token;
      if (url.pathname === "/api/state" && request.method() === "GET" && ok) {
        const job = (job_id: string) => ({
          agent_id: "peer-a",
          job_id,
          session_id: "session-a",
          pid: 11,
          project: "/work/a",
          created_at: timestamp,
          state: "running",
        });
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: { id: "control-multi", name: "Multi-job Command Control" },
            agents: [
              {
                peer_id: "peer-a",
                name: "Agent A",
                host: "127.0.0.1",
                port: 7330,
                paired_at: timestamp,
                skills: ["session.steer", "session.commands"],
                controls: {
                  spawn: false,
                  steer: true,
                  stop: false,
                  abort: false,
                  commands: true,
                },
                jobs_synced_at: 1,
              },
            ],
            sessions: [
              {
                agent_id: "peer-a",
                session_id: "session-a",
                project: "/work/a",
                name: "Session A",
                started_at: timestamp,
                updated_at: timestamp,
                synced_at: timestamp,
              },
            ],
            jobs: [job("job-a"), job("job-b")],
            execution_transport: "confidential",
          }),
        });
        return;
      }
      if (
        url.pathname === "/api/sessions/peer-a/session-a" &&
        request.method() === "GET" &&
        url.search === "" &&
        ok
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            events: [
              {
                entry_id: "e1",
                timestamp,
                data: JSON.stringify({
                  type: "message",
                  message: {
                    role: "user",
                    content: [{ type: "text", text: "hello" }],
                  },
                }),
              },
            ],
            hasEarlier: false,
            total: 1,
            all: false,
            stale: false,
          }),
        });
        return;
      }
      if (
        url.pathname === "/api/agents/peer-a/commands" &&
        request.method() === "GET" &&
        ok
      ) {
        const commandJob = url.searchParams.get("job_id");
        if (commandJob === "job-a") {
          await alphaHeld;
          await route.fulfill({
            contentType: "application/json",
            headers: { "x-fixture": "alpha" },
            body: JSON.stringify({
              commands: [{ name: "alpha-cmd", description: "Alpha" }],
            }),
          });
          return;
        }
        if (commandJob !== "job-b") {
          await route.fulfill({ status: 400, body: "unexpected job_id" });
          return;
        }
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            commands: [{ name: "beta-cmd", description: "Beta" }],
          }),
        });
        return;
      }
      await route.fulfill({ status: 400, body: "unexpected request" });
    });
    await page.goto(baseURL);
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(
      page.getByRole("heading", { name: "Prompt this session" }),
    ).toBeVisible();
    const card = page.locator("#transcript-panel");
    const choose = page.getByLabel("Choose a job");
    // Select job-a (its response is held), then job-b: the list must follow the
    // job the operator actually chose, and job-a's later response must not
    // overwrite it.
    await choose.selectOption("job-a");
    const alphaReceived = page.waitForResponse(
      (response) => response.headers()["x-fixture"] === "alpha",
    );
    await choose.selectOption("job-b");
    await expect(card).toContainText("beta-cmd");
    releaseAlpha();
    await alphaReceived;
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await expect(
      card,
      "an earlier job's response must not overwrite the newly selected job's hints",
    ).not.toContainText("alpha-cmd");
    await expect(card).toContainText("beta-cmd");
  } finally {
    releaseAlpha();
    await page.close();
    await control.stop();
    store.close();
  }
});

test("selecting another job clears the previous hints, and clearing the selection retires an in-flight read", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Hint Clearing Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  const token = store.dashboardToken();
  const timestamp = new Date(0).toISOString();
  let releaseAlpha!: () => void;
  const alphaHeld = new Promise<void>((resolve) => {
    releaseAlpha = resolve;
  });
  try {
    const { port } = await control.start();
    const baseURL = `http://127.0.0.1:${port}`;
    await page.addInitScript(
      (t) => localStorage.setItem("pi_mesh_token", t),
      token,
    );
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const ok = request.headers()["x-pi-mesh-ui"] === token;
      if (url.pathname === "/api/state" && request.method() === "GET" && ok) {
        const job = (job_id: string) => ({
          agent_id: "peer-a",
          job_id,
          session_id: "session-a",
          pid: 11,
          project: "/work/a",
          created_at: timestamp,
          state: "running",
        });
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: { id: "control-clear", name: "Hint Clearing Control" },
            agents: [
              {
                peer_id: "peer-a",
                name: "Agent A",
                host: "127.0.0.1",
                port: 7330,
                paired_at: timestamp,
                skills: ["session.steer", "session.commands"],
                controls: {
                  spawn: false,
                  steer: true,
                  stop: false,
                  abort: false,
                  commands: true,
                },
                jobs_synced_at: 1,
              },
            ],
            sessions: [
              {
                agent_id: "peer-a",
                session_id: "session-a",
                project: "/work/a",
                name: "Session A",
                started_at: timestamp,
                updated_at: timestamp,
                synced_at: timestamp,
              },
            ],
            jobs: [job("job-a"), job("job-b")],
            execution_transport: "confidential",
          }),
        });
        return;
      }
      if (
        url.pathname === "/api/sessions/peer-a/session-a" &&
        request.method() === "GET" &&
        url.search === "" &&
        ok
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            events: [
              {
                entry_id: "e1",
                timestamp,
                data: JSON.stringify({
                  type: "message",
                  message: {
                    role: "user",
                    content: [{ type: "text", text: "hello" }],
                  },
                }),
              },
            ],
            hasEarlier: false,
            total: 1,
            all: false,
            stale: false,
          }),
        });
        return;
      }
      if (
        url.pathname === "/api/agents/peer-a/commands" &&
        request.method() === "GET" &&
        ok
      ) {
        const commandJob = url.searchParams.get("job_id");
        if (commandJob === "job-a") {
          await alphaHeld;
          await route.fulfill({
            contentType: "application/json",
            headers: { "x-fixture": "alpha" },
            body: JSON.stringify({
              commands: [{ name: "alpha-cmd", description: "Alpha" }],
            }),
          });
          return;
        }
        if (commandJob !== "job-b") {
          await route.fulfill({ status: 400, body: "unexpected job_id" });
          return;
        }
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            commands: [{ name: "beta-cmd", description: "Beta" }],
          }),
        });
        return;
      }
      await route.fulfill({ status: 400, body: "unexpected request" });
    });
    await page.goto(baseURL);
    await page.getByRole("button", { name: /Session A/ }).click();
    const card = page.locator("#transcript-panel");
    const choose = page.getByLabel("Choose a job");
    await choose.selectOption("job-b");
    await expect(card).toContainText("beta-cmd");
    // Selecting job-a (held) must clear job-b's hints immediately, not leave them
    // offered while the new read is in flight.
    await choose.selectOption("job-a");
    const alphaReceived = page.waitForResponse(
      (response) => response.headers()["x-fixture"] === "alpha",
    );
    await expect(
      card,
      "the previous job's hints are cleared while the new job loads",
    ).not.toContainText("beta-cmd");
    // Clearing the selection retires the in-flight read: its late response must
    // not repopulate the list.
    await choose.selectOption("");
    releaseAlpha();
    await alphaReceived;
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await expect(
      card,
      "a read retired by clearing the selection must not repopulate the hints",
    ).not.toContainText("alpha-cmd");
  } finally {
    releaseAlpha();
    await page.close();
    await control.stop();
    store.close();
  }
});

test("session status shows the model and context Pi reports, and says unknown when it reports none", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Status Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  const token = store.dashboardToken();
  const timestamp = new Date(0).toISOString();
  let contextUnknown = false;
  try {
    const { port } = await control.start();
    const baseURL = `http://127.0.0.1:${port}`;
    await page.addInitScript(
      (t) => localStorage.setItem("pi_mesh_token", t),
      token,
    );
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const ok = request.headers()["x-pi-mesh-ui"] === token;
      if (url.pathname === "/api/state" && request.method() === "GET" && ok) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: { id: "control-status", name: "Status Control" },
            agents: [
              {
                peer_id: "peer-a",
                name: "Agent A",
                host: "127.0.0.1",
                port: 7330,
                paired_at: timestamp,
                skills: ["session.steer", "session.status"],
                controls: {
                  spawn: false,
                  steer: true,
                  stop: false,
                  abort: false,
                  status: true,
                },
                jobs_synced_at: 1,
              },
            ],
            sessions: [
              {
                agent_id: "peer-a",
                session_id: "session-a",
                project: "/work/a",
                name: "Session A",
                started_at: timestamp,
                updated_at: timestamp,
                synced_at: timestamp,
              },
            ],
            jobs: [
              {
                agent_id: "peer-a",
                job_id: "job-a",
                session_id: "session-a",
                pid: 11,
                project: "/work/a",
                created_at: timestamp,
                state: "running",
              },
            ],
            execution_transport: "confidential",
          }),
        });
        return;
      }
      if (url.pathname === "/api/sync" && request.method() === "POST" && ok) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }
      if (
        url.pathname === "/api/sessions/peer-a/session-a" &&
        request.method() === "GET" &&
        url.search === "" &&
        ok
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            events: [
              {
                entry_id: "e1",
                timestamp,
                data: JSON.stringify({
                  type: "message",
                  message: {
                    role: "user",
                    content: [{ type: "text", text: "hello" }],
                  },
                }),
              },
            ],
            hasEarlier: false,
            total: 1,
            all: false,
            stale: false,
          }),
        });
        return;
      }
      if (
        url.pathname === "/api/agents/peer-a/status" &&
        request.method() === "GET" &&
        ok
      ) {
        expect(
          url.searchParams.get("job_id"),
          "the status read names the running job",
        ).toBe("job-a");
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(
            contextUnknown
              ? {
                  model: {
                    id: "model-a",
                    provider: "provider-a",
                    name: "Model A",
                  },
                  thinkingLevel: "high",
                }
              : {
                  model: {
                    id: "model-a",
                    provider: "provider-a",
                    name: "Model A",
                  },
                  thinkingLevel: "high",
                  tokens: { input: 100, output: 20, total: 120 },
                  cost: 0.5,
                  contextUsage: {
                    tokens: 60000,
                    contextWindow: 200000,
                    percent: 30,
                  },
                },
          ),
        });
        return;
      }
      if (
        url.pathname === "/api/agents/peer-a/steer" &&
        request.method() === "POST" &&
        ok
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            code: -32102,
            message: "Execution is not enabled",
          }),
        });
        return;
      }
      await route.fulfill({ status: 400, body: "unexpected request" });
    });
    await page.goto(baseURL);
    await page.getByRole("button", { name: /Session A/ }).click();
    const card = page.locator("#transcript-panel");
    await expect(card).toContainText("Model: Model A (provider-a)");
    await expect(card).toContainText("thinking: high");
    await expect(card, "Pi's own context numbers are shown").toContainText(
      "context: 60000 / 200000 (30%)",
    );
    // Pi omits contextUsage when it has none; that must read as unknown, never
    // as 0% or a full bar.
    contextUnknown = true;
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(card).toContainText("context: unknown");
    await expect(card).not.toContainText("context: 60000");
    // After a reload the card repaints; a snapshot wrongly stored in the prompt
    // feedback field would surface here as [object Object].
    await expect(card).not.toContainText("[object Object]");
    // The status snapshot and the prompt feedback are separate state: a send must
    // still render its own refusal, never "[object Object]".
    await page
      .getByRole("textbox", { name: "Message to session" })
      .fill("hello");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(card).toContainText(
      "Agent refusal (-32102): Execution is not enabled",
    );
    await expect(card).not.toContainText("[object Object]");
  } finally {
    await page.close();
    await control.stop();
    store.close();
  }
});

test("session status renders for an agent that advertises it but not steering", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Status Without Steering Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  const token = store.dashboardToken();
  const timestamp = new Date(0).toISOString();
  try {
    const { port } = await control.start();
    const baseURL = `http://127.0.0.1:${port}`;
    await page.addInitScript(
      (t) => localStorage.setItem("pi_mesh_token", t),
      token,
    );
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const ok = request.headers()["x-pi-mesh-ui"] === token;
      if (url.pathname === "/api/state" && request.method() === "GET" && ok) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: {
              id: "control-status-only",
              name: "Status Without Steering Control",
            },
            agents: [
              {
                peer_id: "peer-a",
                name: "Agent A",
                host: "127.0.0.1",
                port: 7330,
                paired_at: timestamp,
                skills: ["session.status"],
                controls: {
                  spawn: false,
                  steer: false,
                  stop: false,
                  abort: false,
                  status: true,
                },
                jobs_synced_at: 1,
              },
            ],
            sessions: [
              {
                agent_id: "peer-a",
                session_id: "session-a",
                project: "/work/a",
                name: "Session A",
                started_at: timestamp,
                updated_at: timestamp,
                synced_at: timestamp,
              },
            ],
            jobs: [
              {
                agent_id: "peer-a",
                job_id: "job-a",
                session_id: "session-a",
                pid: 11,
                project: "/work/a",
                created_at: timestamp,
                state: "running",
              },
            ],
            execution_transport: "confidential",
          }),
        });
        return;
      }
      if (
        url.pathname === "/api/sessions/peer-a/session-a" &&
        request.method() === "GET" &&
        url.search === "" &&
        ok
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            events: [
              {
                entry_id: "e1",
                timestamp,
                data: JSON.stringify({
                  type: "message",
                  message: {
                    role: "user",
                    content: [{ type: "text", text: "hello" }],
                  },
                }),
              },
            ],
            hasEarlier: false,
            total: 1,
            all: false,
            stale: false,
          }),
        });
        return;
      }
      if (
        url.pathname === "/api/agents/peer-a/status" &&
        request.method() === "GET" &&
        ok
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            model: { id: "model-a", provider: "provider-a", name: "Model A" },
            contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 },
          }),
        });
        return;
      }
      await route.fulfill({ status: 400, body: "unexpected request" });
    });
    await page.goto(baseURL);
    await page.getByRole("button", { name: /Session A/ }).click();
    const card = page.locator("#transcript-panel");
    await expect(
      card,
      "an advertised status read renders even when steering is not granted",
    ).toContainText("Model: Model A (provider-a)");
    await expect(card).toContainText("context: 60000 / 200000 (30%)");
    await expect(
      page.getByRole("textbox", { name: "Message to session" }),
      "steering is still unavailable, so there is no composer",
    ).toHaveCount(0);
  } finally {
    await page.close();
    await control.stop();
    store.close();
  }
});

test("a status response that arrives after a reload does not repopulate the card", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Status Reload Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  const token = store.dashboardToken();
  const timestamp = new Date(0).toISOString();
  let statusCalls = 0;
  let stateCalls = 0;
  let holdState = false;
  let releaseState!: () => void;
  const stateGate = new Promise<void>((resolve) => {
    releaseState = resolve;
  });
  let stateStarted!: () => void;
  const stateStartedGate = new Promise<void>((resolve) => {
    stateStarted = resolve;
  });
  let statusStarted!: () => void;
  const statusStartedGate = new Promise<void>((resolve) => {
    statusStarted = resolve;
  });
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  try {
    const { port } = await control.start();
    const baseURL = `http://127.0.0.1:${port}`;
    await page.addInitScript(
      (t) => localStorage.setItem("pi_mesh_token", t),
      token,
    );
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const ok = request.headers()["x-pi-mesh-ui"] === token;
      if (url.pathname === "/api/state" && request.method() === "GET" && ok) {
        stateCalls += 1;
        // Hold the reload's own state read so the stale status response can be
        // released in the window between invalidation and the next render.
        if (holdState && stateCalls === 2) {
          stateStarted();
          await stateGate;
        }
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: { id: "control-reload", name: "Status Reload Control" },
            agents: [
              {
                peer_id: "peer-a",
                name: "Agent A",
                host: "127.0.0.1",
                port: 7330,
                paired_at: timestamp,
                skills: ["session.steer", "session.status"],
                controls: {
                  spawn: false,
                  steer: true,
                  stop: false,
                  abort: false,
                  status: true,
                },
                jobs_synced_at: 1,
              },
            ],
            sessions: [
              {
                agent_id: "peer-a",
                session_id: "session-a",
                project: "/work/a",
                name: "Session A",
                started_at: timestamp,
                updated_at: timestamp,
                synced_at: timestamp,
              },
            ],
            jobs: [
              {
                agent_id: "peer-a",
                job_id: "job-a",
                session_id: "session-a",
                pid: 11,
                project: "/work/a",
                created_at: timestamp,
                state: "running",
              },
            ],
            execution_transport: "confidential",
          }),
        });
        return;
      }
      if (url.pathname === "/api/sync" && request.method() === "POST" && ok) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }
      if (
        url.pathname === "/api/sessions/peer-a/session-a" &&
        request.method() === "GET" &&
        url.search === "" &&
        ok
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            events: [
              {
                entry_id: "e1",
                timestamp,
                data: JSON.stringify({
                  type: "message",
                  message: {
                    role: "user",
                    content: [{ type: "text", text: "hello" }],
                  },
                }),
              },
            ],
            hasEarlier: false,
            total: 1,
            all: false,
            stale: false,
          }),
        });
        return;
      }
      if (
        url.pathname === "/api/agents/peer-a/status" &&
        request.method() === "GET" &&
        ok
      ) {
        statusCalls += 1;
        if (statusCalls === 1) {
          statusStarted();
          await firstHeld;
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              model: { id: "model-a", provider: "provider-a", name: "Model A" },
              contextUsage: {
                tokens: 60000,
                contextWindow: 200000,
                percent: 30,
              },
            }),
          });
          return;
        }
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            model: { id: "model-b", provider: "provider-b", name: "Model B" },
            contextUsage: { tokens: 1000, contextWindow: 200000, percent: 1 },
          }),
        });
        return;
      }
      await route.fulfill({ status: 400, body: "unexpected request" });
    });
    await page.goto(baseURL);
    await page.getByRole("button", { name: /Session A/ }).click();
    const card = page.locator("#transcript-panel");
    // The first status read is in flight and held; a reload now supersedes it.
    await statusStartedGate;
    holdState = true;
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await stateStartedGate;
    // Invalidation has run; the reload's state read is still pending. Release the
    // stale status response now: it must be discarded, not applied and cached.
    releaseFirst();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    releaseState();
    await expect(card).toContainText("Model: Model B (provider-b)");
    await expect(
      card,
      "a status read retired by reloading must not overwrite the fresh one",
    ).not.toContainText("Model: Model A");
    await expect(card).toContainText("context: 1000 / 200000 (1%)");
  } finally {
    releaseState();
    releaseFirst();
    await page.close();
    await control.stop();
    store.close();
  }
});

test("resume requires the inline corruption warning confirmation and syncs before prompting", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Resume Safety Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  const token = store.dashboardToken();
  const fixtureErrors: string[] = [];
  const posts: string[] = [];
  const timestamp = new Date(0).toISOString();
  let resumed = false;
  let confirmedResume = false;
  let listedJobId = "other-job";
  let releaseSync!: () => void;
  const syncGate = new Promise<void>((resolve) => {
    releaseSync = resolve;
  });
  let transcriptStale = false;
  let resumeCapability = true;
  let activeJob = false;
  let jobsFresh = true;
  let transport: "confidential" | "refused" = "confidential";
  let resumeMode: "success" | "refusal" | "failure" | "transport" = "success";
  const session = {
    agent_id: "peer-a",
    session_id: "saved-session",
    project: "/work/a",
    name: "Saved session",
    started_at: timestamp,
    updated_at: timestamp,
    synced_at: timestamp,
  };
  try {
    const { port } = await control.start();
    const baseURL = `http://127.0.0.1:${port}`;
    await page.addInitScript(
      (dashboardToken) => localStorage.setItem("pi_mesh_token", dashboardToken),
      token,
    );
    await page.addInitScript(
      "window.confirm = () => { throw new Error('resume must not invoke window.confirm'); };",
    );
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const authenticated = request.headers()["x-pi-mesh-ui"] === token;
      if (
        url.pathname === "/api/state" &&
        request.method() === "GET" &&
        authenticated
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: { id: "control-a", name: "Resume Safety Control" },
            agents: [
              {
                peer_id: "peer-a",
                name: "Agent A",
                host: "127.0.0.1",
                port: 7330,
                paired_at: timestamp,
                skills: resumeCapability
                  ? ["session.resume", "session.steer"]
                  : ["session.steer"],
                controls: {
                  spawn: false,
                  steer: true,
                  stop: false,
                  abort: false,
                  resume: resumeCapability,
                },
                jobs_synced_at: jobsFresh ? (confirmedResume ? 2 : 1) : null,
              },
            ],
            sessions: [session],
            jobs:
              confirmedResume || activeJob
                ? [
                    {
                      agent_id: "peer-a",
                      job_id: listedJobId,
                      session_id: "saved-session",
                      pid: 123,
                      project: "/work/a",
                      created_at: timestamp,
                      state: "running",
                    },
                  ]
                : [],
            execution_transport: transport,
          }),
        });
        return;
      }
      if (
        url.pathname === "/api/sessions/peer-a/saved-session" &&
        request.method() === "GET" &&
        authenticated
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            events: [],
            hasEarlier: false,
            total: 0,
            all: false,
            stale: transcriptStale,
          }),
        });
        return;
      }
      if (
        url.pathname === "/api/agents/peer-a/resume" &&
        request.method() === "POST" &&
        authenticated
      ) {
        const body = request.postDataJSON() as Record<string, unknown>;
        if (
          Object.keys(body).sort().join(",") !==
            "acknowledge_concurrent_writers,session_id" ||
          body.session_id !== "saved-session" ||
          body.acknowledge_concurrent_writers !== true
        ) {
          fixtureErrors.push(
            "resume must contain only the selected session_id and explicit writer-risk acknowledgement",
          );
          await route.fulfill({ status: 400, body: "invalid resume input" });
          return;
        }
        posts.push("resume");
        if (resumeMode === "refusal") {
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              code: -32102,
              message: "Execution is not enabled",
            }),
          });
        } else if (resumeMode === "failure" || resumeMode === "transport") {
          await route.fulfill({
            status: resumeMode === "transport" ? 403 : 502,
            contentType: "application/json",
            body: JSON.stringify({
              error:
                resumeMode === "transport"
                  ? "confidential_transport_required"
                  : "agent_unreachable",
            }),
          });
        } else {
          resumed = true;
          jobsFresh = false;
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              result: {
                job_id: "resumed-job",
                session_id: "saved-session",
                pid: 123,
              },
            }),
          });
        }
        return;
      }
      if (
        url.pathname === "/api/sync" &&
        request.method() === "POST" &&
        authenticated
      ) {
        posts.push("sync");
        if (resumed) {
          await syncGate;
          confirmedResume = true;
          jobsFresh = true;
        }
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ results: [] }),
        });
        return;
      }
      fixtureErrors.push(
        `unexpected request ${request.method()} ${url.pathname}${url.search}`,
      );
      await route.fulfill({
        status: 400,
        body: "unexpected dashboard request",
      });
    });
    await page.goto(baseURL);
    const panel = page.locator("#transcript-panel");
    async function selectSession() {
      await page.getByRole("button", { name: /Saved session/ }).click();
      await expect(
        panel.getByRole("heading", { name: "Prompt this session" }),
      ).toBeVisible();
    }
    for (const setup of [
      () => {
        transcriptStale = true;
      },
      () => {
        transcriptStale = false;
        resumeCapability = false;
      },
      () => {
        resumeCapability = true;
        activeJob = true;
      },
      () => {
        activeJob = false;
        jobsFresh = false;
      },
      () => {
        jobsFresh = true;
        transport = "refused";
      },
    ]) {
      setup();
      await page.reload();
      await selectSession();
      await expect(
        panel.getByRole("button", { name: "Resume" }),
        "resume is unavailable without a verified session, advertised capability, fresh jobs, no active job, and permitted transport",
      ).toHaveCount(0);
    }
    transcriptStale = false;
    resumeCapability = true;
    activeJob = false;
    jobsFresh = true;
    transport = "confidential";
    await page.reload();
    await selectSession();
    const warning =
      "This writes to the existing Pi session file. pi-mesh cannot tell whether a separate Pi TUI is still using it. Resuming while that TUI is active may corrupt the session or lose conversation history. Close the other Pi session before continuing. If you cannot confirm it has exited, do not resume this file.";
    await expect(
      panel,
      "named warning clause presents ADR 0019's full concurrent-writer warning inline",
    ).toContainText(warning);
    const confirm = page.getByLabel(
      "I have closed any other Pi process using this session file and understand the risk.",
    );
    await expect(confirm).not.toBeChecked();
    await page.getByRole("button", { name: "Resume" }).click();
    expect(
      posts,
      "named confirmation clause requires an initially unchecked assertion for each attempt",
    ).toEqual([]);
    for (const [mode, expected] of [
      ["refusal", "Agent refusal (-32102): Execution is not enabled"],
      ["failure", "Agent call failed (502): agent_unreachable"],
      [
        "transport",
        "Control-plane transport refusal: confidential_transport_required.",
      ],
    ] as const) {
      resumeMode = mode;
      await confirm.check();
      await page.getByRole("button", { name: "Resume" }).click();
      await expect(panel).toContainText(expected);
      await expect(
        page.getByLabel(
          "I have closed any other Pi process using this session file and understand the risk.",
        ),
      ).not.toBeChecked();
    }
    resumeMode = "success";
    await page
      .getByLabel(
        "I have closed any other Pi process using this session file and understand the risk.",
      )
      .check();
    await page
      .locator("#transcript-panel .agent-section")
      .filter({
        has: page.getByRole("heading", { name: "Resume saved session" }),
      })
      .getByRole("button", { name: "Resume" })
      .evaluate((button) => {
        button.dispatchEvent(new Event("click", { bubbles: true }));
        button.dispatchEvent(new Event("click", { bubbles: true }));
      });
    await expect
      .poll(() => posts.filter((item) => item === "resume").length)
      .toBe(4);
    await expect
      .poll(() => posts.filter((item) => item === "sync").length)
      .toBe(1);
    await expect(
      panel.getByRole("textbox", { name: "Message to session" }),
      "a pending post-resume sync cannot make Prompt available",
    ).toHaveCount(0);
    releaseSync();
    await expect(
      panel.getByRole("textbox", { name: "Message to session" }),
      "a different running job cannot confirm the returned resume job",
    ).toHaveCount(0);
    await expect(
      panel,
      "a different running job cannot confirm the returned resume job",
    ).toContainText(
      "Resume accepted, but Sync did not confirm the resumed job",
    );
    await expect(
      panel.getByRole("textbox", { name: "Message to session" }),
      "named resumed-job identity clause: a different listed job cannot unlock Prompt",
    ).toHaveCount(0);
    listedJobId = "resumed-job";
    await page.locator("#sync").click();
    await expect(
      panel.getByRole("textbox", { name: "Message to session" }),
    ).toBeVisible();
    expect(posts.lastIndexOf("resume")).toBeLessThan(posts.indexOf("sync"));
    expect(
      fixtureErrors,
      "strict resume fixture rejects unexpected method, route, and body",
    ).toEqual([]);
  } finally {
    releaseSync();
    await page.close();
    try {
      await control.stop();
    } finally {
      store.close();
    }
  }
});

test("dashboard start suggests agent projects, confirms inline, and guards duplicate starts", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Start Form Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  const token = store.dashboardToken();
  const fixtureErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const posts: Array<{ peer: string; body: unknown }> = [];
  const timestamp = new Date(0).toISOString();
  let mode: "success" | "refusal" | "failure" | "transport" | "delayed" =
    "success";
  let spawned = false;
  let syncPosts = 0;
  let modelsFail = false;
  let releaseDelayed!: () => void;
  const delayed = new Promise<void>((resolve) => {
    releaseDelayed = resolve;
  });
  try {
    const { port } = await control.start();
    const baseURL = `http://127.0.0.1:${port}`;
    await page.addInitScript(
      (dashboardToken) => localStorage.setItem("pi_mesh_token", dashboardToken),
      token,
    );
    await page.addInitScript(
      "window.confirm = () => { throw new Error('start form must not invoke window.confirm'); };",
    );
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const authenticated = request.headers()["x-pi-mesh-ui"] === token;
      if (
        url.pathname === "/api/state" &&
        request.method() === "GET" &&
        authenticated &&
        request.postData() === null
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: { id: "control-a", name: "Start Form Control" },
            agents: ["peer-a", "peer-b", "peer-c"].map((peer_id) => ({
              peer_id,
              name:
                peer_id === "peer-a"
                  ? "Agent A"
                  : peer_id === "peer-b"
                    ? "Agent B"
                    : "Agent C",
              host: "127.0.0.1",
              port: 7330,
              paired_at: timestamp,
              skills: ["process.spawn"],
              controls: {
                spawn: true,
                steer: false,
                stop: false,
                abort: false,
              },
              jobs_synced_at: null,
            })),
            sessions: [
              {
                agent_id: "peer-a",
                session_id: "s-a",
                project: "/work/alpha",
                name: "A",
                started_at: timestamp,
                updated_at: timestamp,
                synced_at: timestamp,
              },
              {
                agent_id: "peer-a",
                session_id: "s-a2",
                project: "/work/shared",
                name: "A2",
                started_at: timestamp,
                updated_at: timestamp,
                synced_at: timestamp,
              },
              {
                agent_id: "peer-b",
                session_id: "s-b",
                project: "/other/beta",
                name: "B",
                started_at: timestamp,
                updated_at: timestamp,
                synced_at: timestamp,
              },
              ...(spawned
                ? [
                    {
                      agent_id: "peer-a",
                      session_id: "session-new",
                      project: "/work/manual",
                      name: "New session",
                      started_at: timestamp,
                      updated_at: timestamp,
                      synced_at: timestamp,
                    },
                  ]
                : []),
            ],
            jobs: [
              {
                agent_id: "peer-a",
                job_id: "cached-a",
                session_id: "s-a",
                pid: 1,
                project: "/work/job-only",
                created_at: timestamp,
                state: "exited",
              },
              {
                agent_id: "peer-b",
                job_id: "cached-b",
                session_id: "s-b",
                pid: 2,
                project: "/other/job-only",
                created_at: timestamp,
                state: "exited",
              },
            ],
            execution_transport: "confidential",
          }),
        });
        return;
      }
      if (
        url.pathname === "/api/sync" &&
        request.method() === "POST" &&
        authenticated &&
        request.postData() === null
      ) {
        syncPosts += 1;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ results: [] }),
        });
        return;
      }
      if (
        request.method() === "GET" &&
        /^\/api\/agents\/peer-[abc]\/models$/.test(url.pathname) &&
        authenticated &&
        request.postData() === null
      ) {
        // The pre-spawn catalog the Start form loads. peer-c models the
        // unavailable helper so the selector's degrade path is exercised by a
        // real request rather than assumed; peer-a can be made to fail after a
        // successful load to model a snapshot that can no longer be refreshed.
        if (
          url.pathname === "/api/agents/peer-c/models" ||
          (url.pathname === "/api/agents/peer-a/models" && modelsFail)
        ) {
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              code: -32106,
              message: "helper timed out",
            }),
          });
          return;
        }
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            models: [
              {
                id: "test-model",
                provider: "test-provider",
                name: "Test Model",
              },
            ],
          }),
        });
        return;
      }
      if (
        url.pathname === "/api/agents/peer-a/spawn" &&
        request.method() === "POST" &&
        authenticated &&
        request.headers()["content-type"] === "application/json"
      ) {
        const body = request.postDataJSON() as Record<string, unknown>;
        const keys = Object.keys(body).sort().join(",");
        const model = body.model as
          { provider?: unknown; model_id?: unknown } | undefined;
        if (
          ![
            "project,prompt",
            "cwd,project,prompt",
            "model,project,prompt",
            "cwd,model,project,prompt",
          ].includes(keys) ||
          (keys.includes("model") &&
            (model?.provider !== "test-provider" ||
              model?.model_id !== "test-model"))
        ) {
          fixtureErrors.push(`invalid spawn fields ${JSON.stringify(body)}`);
          await route.fulfill({ status: 400, body: "invalid spawn fields" });
          return;
        }
        posts.push({ peer: "peer-a", body });
        if (mode === "delayed") await delayed;
        if (mode === "refusal") {
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              code: -32102,
              message: "Execution is not enabled",
            }),
          });
        } else if (mode === "failure" || mode === "transport") {
          await route.fulfill({
            status: mode === "transport" ? 403 : 502,
            contentType: "application/json",
            body: JSON.stringify({
              error:
                mode === "transport"
                  ? "confidential_transport_required"
                  : "agent_unreachable",
            }),
          });
        } else {
          spawned = mode === "success";
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              result: {
                job_id: "job-new",
                session_id: "session-new",
                pid: 4242,
              },
            }),
          });
        }
        return;
      }
      if (
        url.pathname === "/api/sessions/peer-a/session-new" &&
        request.method() === "GET" &&
        authenticated &&
        request.postData() === null
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            events: [],
            hasEarlier: false,
            total: 0,
            all: false,
            stale: !spawned,
          }),
        });
        return;
      }
      fixtureErrors.push(
        `unexpected request ${request.method()} ${url.pathname}${url.search}`,
      );
      await route.fulfill({
        status: 400,
        body: "unexpected dashboard request",
      });
    });
    await page.goto(baseURL);
    await expect(
      page.getByRole("heading", { name: "Start Form Control" }),
    ).toBeVisible();
    const formA = page
      .locator("#agents .agent-section")
      .filter({ has: page.getByRole("heading", { name: "Agent A" }) })
      .locator("form");
    const formB = page
      .locator("#agents .agent-section")
      .filter({ has: page.getByRole("heading", { name: "Agent B" }) })
      .locator("form");
    const projectA = formA.getByLabel("Project");
    const formC = page
      .locator("#agents .agent-section")
      .filter({ has: page.getByRole("heading", { name: "Agent C" }) })
      .locator("form");
    const projectB = formB.getByLabel("Project");
    await expect(projectA).toHaveAttribute("list", "projects-peer-a");
    await expect(
      page.locator("#projects-peer-a option"),
      "cached project suggestions stay agent-scoped",
    ).toHaveCount(3);
    await expect(
      page.locator("#projects-peer-a option[value='/work/alpha']"),
      "full project path is the suggestion value",
    ).toHaveAttribute("label", "alpha");
    await expect(
      page.locator("#projects-peer-a option[value='/work/shared']"),
    ).toHaveCount(1);
    await expect(
      page.locator("#projects-peer-a option[value='/work/job-only']"),
    ).toHaveCount(1);
    await expect(
      page.locator("#projects-peer-a option[value='/other/beta']"),
    ).toHaveCount(0);
    await expect(page.locator("#projects-peer-b option")).toHaveCount(2);
    await expect(formB).toContainText(
      "Suggestions from cached sessions and jobs",
    );
    await expect(projectB).toHaveAttribute("list", "projects-peer-b");
    await expect(page.locator("#projects-peer-c option")).toHaveCount(0);
    await expect(formC).toContainText(
      "No cached projects for this agent yet. Enter a project name.",
    );
    await expect(formC.getByLabel("Project")).toBeEditable();
    await expect(
      formC.getByLabel("Model"),
      "a catalog-unavailable agent disables the selector rather than offering a stale list",
    ).toBeDisabled();
    await expect(
      formC,
      "the degrade states the reason and keeps the machine default",
    ).toContainText("Model catalog unavailable: helper timed out");
    await expect(formC.getByLabel("Model")).toContainText(
      "Use this machine's default",
    );
    const reviewStart = formA.getByRole("button", { name: "Review start" });
    await expect(reviewStart).toBeDisabled();
    await expect(
      formA.getByRole("button", { name: "Start", exact: true }),
    ).toHaveCount(0);
    await projectA.fill("/work/manual");
    await formA.getByLabel("Prompt").fill("first prompt");
    await formA.evaluate(async (form) => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(
      posts,
      "inline review is required even with filled fields and a synthetic submit",
    ).toHaveLength(0);
    await reviewStart.click();
    await expect(
      formA.locator(".start-review"),
      "review step names the agent and project before starting",
    ).toContainText("Start one session on Agent A for /work/manual?");
    await formA.getByRole("button", { name: "Cancel" }).click();
    await expect(projectA, "Cancel keeps entered project").toHaveValue(
      "/work/manual",
    );
    await expect(
      formA.getByLabel("Prompt"),
      "Cancel keeps entered prompt",
    ).toHaveValue("first prompt");
    await expect(
      formA.getByRole("button", { name: "Start", exact: true }),
      "Cancel closes the inline review",
    ).toHaveCount(0);
    expect(posts, "Cancel does not start a session").toHaveLength(0);
    await reviewStart.click();
    await projectA.fill("/work/different");
    await expect(
      formA.getByRole("button", { name: "Start", exact: true }),
      "changing the reviewed project requires a new review",
    ).toHaveCount(0);
    await projectA.fill("/work/manual");
    await formA
      .getByLabel("Model")
      .selectOption(
        JSON.stringify({ provider: "test-provider", model_id: "test-model" }),
      );
    await reviewStart.click();
    await expect(
      formA.locator(".start-review"),
      "the review names the chosen model before submission",
    ).toContainText("using test-provider/test-model");
    await formA.getByRole("button", { name: "Start", exact: true }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(
      posts[0]?.body,
      "the start request carries the chosen model, not a free string",
    ).toEqual({
      project: "/work/manual",
      prompt: "first prompt",
      model: { provider: "test-provider", model_id: "test-model" },
    });
    await expect
      .poll(() => syncPosts, {
        message:
          "a successful start syncs, so the new job's live view is not stranded behind an unconfirmed listing",
      })
      .toBeGreaterThanOrEqual(1);
    // A reload drops the snapshot and re-fetches: with the catalog now
    // unavailable, the selector must degrade to the machine default with the
    // reason, not keep offering the list it loaded before (ADR 0017).
    modelsFail = true;
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(
      formA.getByLabel("Model"),
      "a failed refresh disables the selector rather than showing a stale list",
    ).toBeDisabled();
    await expect(formA).toContainText(
      "Model catalog unavailable: helper timed out",
    );
    await expect(formA.getByLabel("Model")).toContainText(
      "Use this machine's default",
    );
    modelsFail = false;
    await expect(
      page.getByText("Started job job-new, session session-new, PID 4242."),
    ).toBeVisible();
    await expect(formA.getByLabel("Project")).toHaveValue("/work/manual");
    await page.getByRole("button", { name: "Open session" }).click();
    await expect(
      page.getByRole("heading", { name: "New session" }),
    ).toBeVisible();
    await expect(page.locator("#transcript-status")).toContainText(
      "Loaded session session-new.",
    );
    await expect(page.locator("#transcript-panel")).toContainText(
      "No transcript entries yet; the session may still be starting.",
    );

    // Restore the catalog, then carry a chosen model through a REFUSED start:
    // the refusal must keep project, prompt, cwd, model and the inline review so
    // the operator can retry, per M5-4, even though the reload re-fetched.
    modelsFail = false;
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(formA.getByLabel("Model")).toBeEnabled();
    await formA
      .getByLabel("Model")
      .selectOption(
        JSON.stringify({ provider: "test-provider", model_id: "test-model" }),
      );
    mode = "refusal";
    await formA.getByLabel("Project").fill("/work/refused");
    await formA.getByLabel("Prompt").fill("refused prompt");
    await formA
      .getByLabel("Working directory (optional)")
      .fill("/work/refused-dir");
    await reviewStart.click();
    await expect(
      formA.locator(".start-review"),
      "optional cwd and the chosen model appear in the review before submission",
    ).toContainText(
      "Start one session on Agent A for /work/refused in /work/refused-dir using test-provider/test-model?",
    );
    await formA.getByRole("button", { name: "Start", exact: true }).click();
    await expect(
      page.getByText("Agent refusal (-32102): Execution is not enabled"),
    ).toBeVisible();
    await expect(formA.getByLabel("Project")).toHaveValue("/work/refused");
    await expect(formA.getByLabel("Prompt")).toHaveValue("refused prompt");
    await expect(formA.getByLabel("Working directory (optional)")).toHaveValue(
      "/work/refused-dir",
    );
    expect(
      posts.at(-1)?.body,
      "refused start sends exact project, prompt, optional cwd and the chosen model",
    ).toEqual({
      project: "/work/refused",
      prompt: "refused prompt",
      cwd: "/work/refused-dir",
      model: { provider: "test-provider", model_id: "test-model" },
    });
    await expect(
      formA.getByLabel("Model"),
      "a refusal keeps the reviewed model across the reload",
    ).toHaveValue(
      JSON.stringify({ provider: "test-provider", model_id: "test-model" }),
    );
    await expect(formA.locator(".start-review")).toContainText(
      "using test-provider/test-model",
    );
    await expect(
      formA.getByRole("button", { name: "Start", exact: true }),
    ).toBeEnabled();
    // Drop the model so the later flows assert their own clauses without it.
    await formA.getByLabel("Model").selectOption("");

    mode = "failure";
    await formA.getByLabel("Project").fill("/work/failed");
    await formA.getByLabel("Prompt").fill("failed prompt");
    await formA.getByLabel("Working directory (optional)").fill("");
    await reviewStart.click();
    await formA.getByRole("button", { name: "Start", exact: true }).click();
    await expect(
      page.getByText("Agent call failed (502): agent_unreachable"),
    ).toBeVisible();
    await expect(formA.getByLabel("Project")).toHaveValue("/work/failed");
    await expect(formA.getByLabel("Prompt")).toHaveValue("failed prompt");
    expect(
      posts.at(-1)?.body,
      "failed retry uses current fields without stale cwd",
    ).toEqual({ project: "/work/failed", prompt: "failed prompt" });

    mode = "transport";
    await formA.getByLabel("Project").fill("/work/blocked");
    await formA.getByLabel("Prompt").fill("blocked prompt");
    await reviewStart.click();
    await formA.getByRole("button", { name: "Start", exact: true }).click();
    await expect(
      page.getByText(
        "Control-plane transport refusal: confidential_transport_required.",
      ),
    ).toBeVisible();
    await expect(formA.getByLabel("Project")).toHaveValue("/work/blocked");
    await expect(formA.getByLabel("Prompt")).toHaveValue("blocked prompt");
    expect(
      posts.at(-1)?.body,
      "403 retry keeps exact message and project",
    ).toEqual({ project: "/work/blocked", prompt: "blocked prompt" });

    mode = "delayed";
    await formA.getByLabel("Project").fill("/work/delayed");
    await formA.getByLabel("Prompt").fill("delayed prompt");
    await reviewStart.click();
    await formA.getByRole("button", { name: "Start", exact: true }).click();
    await expect.poll(() => posts.length).toBe(5);
    await expect(
      formA.getByRole("button", { name: "Start", exact: true }),
      "start button disabled while the request is in flight",
    ).toBeDisabled();
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(
      formA.getByRole("button", { name: "Start", exact: true }),
      "start stays pending after a fleet re-render",
    ).toBeDisabled();
    await formA.evaluate(async (form) => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(
      posts,
      "duplicate start submission is blocked synchronously while the request is pending",
    ).toHaveLength(5);
    releaseDelayed();
    await expect(
      page.getByText("Started job job-new, session session-new, PID 4242."),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Session not in the cached list yet. Open to check it, or Sync to add it to the list.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open session" }),
      "successful spawn offers Open before the session is cached",
    ).toBeVisible();
    await page.getByRole("button", { name: "Open session" }).click();
    await expect(
      page.getByRole("heading", { name: "session-new" }),
      "returned but uncached session is directly openable",
    ).toBeVisible();
    await expect(
      page.locator("#transcript-status"),
      "unreadable new session is not called loaded",
    ).toContainText("Could not verify session session-new.");
    await expect(page.locator("#transcript-panel")).toContainText(
      "No cached transcript entries.",
    );
    expect(
      posts.at(-1)?.body,
      "delayed start retained its approved fields",
    ).toEqual({ project: "/work/delayed", prompt: "delayed prompt" });
    expect(
      pageErrors,
      "start flow does not call blocking window.confirm or throw in the browser",
    ).toEqual([]);
    expect(
      fixtureErrors,
      "strict start fixture rejects unexpected methods, paths, headers, and payloads",
    ).toEqual([]);
  } finally {
    releaseDelayed();
    await page.close();
    try {
      await control.stop();
    } finally {
      store.close();
    }
  }
});

test("a superseded pre-spawn catalog response does not repopulate the Start form", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Catalog Race Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  const token = store.dashboardToken();
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstStartedGate = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let modelsRequests = 0;
  const timestamp = new Date(0).toISOString();
  try {
    const { port } = await control.start();
    const baseURL = `http://127.0.0.1:${port}`;
    await page.addInitScript(
      (t) => localStorage.setItem("pi_mesh_token", t),
      token,
    );
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const authenticated = request.headers()["x-pi-mesh-ui"] === token;
      if (
        url.pathname === "/api/state" &&
        request.method() === "GET" &&
        authenticated
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: { id: "control-race", name: "Catalog Race Control" },
            agents: [
              {
                peer_id: "peer-a",
                name: "Agent A",
                host: "127.0.0.1",
                port: 7330,
                paired_at: timestamp,
                skills: ["process.spawn"],
                controls: {
                  spawn: true,
                  steer: false,
                  stop: false,
                  abort: false,
                },
                jobs_synced_at: null,
              },
            ],
            sessions: [],
            jobs: [],
            execution_transport: "confidential",
          }),
        });
        return;
      }
      if (url.pathname === "/api/sync" && request.method() === "POST") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }
      if (
        url.pathname === "/api/agents/peer-a/models" &&
        request.method() === "GET" &&
        authenticated
      ) {
        modelsRequests += 1;
        if (modelsRequests === 1) {
          firstStarted();
          await firstHeld;
          await route.fulfill({
            contentType: "application/json",
            headers: { "x-fixture": "stale" },
            body: JSON.stringify({
              models: [
                {
                  id: "old-model",
                  provider: "old-provider",
                  name: "Old Model",
                },
              ],
            }),
          });
          return;
        }
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            models: [
              { id: "new-model", provider: "new-provider", name: "New Model" },
            ],
          }),
        });
        return;
      }
      await route.fulfill({ status: 400, body: "unexpected request" });
    });
    await page.goto(baseURL);
    const form = page
      .locator("#agents .agent-section")
      .filter({ has: page.getByRole("heading", { name: "Agent A" }) })
      .locator("form");
    await firstStartedGate;
    // Reload while the first response is still in flight: it answers a snapshot
    // the reload already discarded.
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(
      form.getByLabel("Model"),
      "the reload's own response populates the selector",
    ).toContainText("New Model");
    // Synchronise on the superseded response being RECEIVED, then let the page
    // process it, so the negative assertion cannot pass before the guarded
    // response arrives (a passing `+= 0` mutant must fail THIS clause).
    const staleReceived = page.waitForResponse(
      (response) => response.headers()["x-fixture"] === "stale",
    );
    releaseFirst();
    await staleReceived;
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await expect(
      form.getByLabel("Model"),
      "the superseded response must not repopulate the selector",
    ).not.toContainText("Old Model");
    await expect(form.getByLabel("Model")).toContainText("New Model");
  } finally {
    releaseFirst();
    await page.close();
    await control.stop();
    store.close();
  }
});

test("selected-session model control is capability-, job-, and owner-bound", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Model Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  const token = store.dashboardToken();
  const fixtureErrors: string[] = [];
  const timestamp = new Date(0).toISOString();
  let scenario = "ready";
  let resolveModelsA!: () => void;
  let modelsAStarted!: () => void;
  let modelsARequestCount = 0;
  let holdTranscriptA = false;
  let releaseTranscriptA!: () => void;
  const transcriptAGate = new Promise<void>((resolve) => {
    releaseTranscriptA = resolve;
  });
  const modelsAGate = new Promise<void>((resolve) => {
    resolveModelsA = resolve;
  });
  const modelsAStartedGate = new Promise<void>((resolve) => {
    modelsAStarted = resolve;
  });
  const body = {
    job_id: "job-model",
    provider: "provider-a",
    model_id: "model-a",
  };
  try {
    const { port } = await control.start();
    await page.addInitScript(
      (value) => localStorage.setItem("pi_mesh_token", value),
      token,
    );
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const authorized = request.headers()["x-pi-mesh-ui"] === token;
      if (!authorized)
        fixtureErrors.push("model API request omitted dashboard token header");
      if (
        request.method() === "GET" &&
        url.pathname === "/api/state" &&
        url.search === "" &&
        request.postData() === null
      ) {
        const skills =
          scenario === "no-capability"
            ? ["session.steer"]
            : ["session.steer", "session.models", "session.set_model"];
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: { id: "control-a", name: "Model Control" },
            agents: [
              {
                peer_id: "peer-a",
                name: "Agent A",
                host: "127.0.0.1",
                port: 7330,
                paired_at: timestamp,
                skills,
                controls: {
                  spawn: false,
                  steer: true,
                  stop: false,
                  abort: false,
                  models: skills.includes("session.models"),
                  setModel: skills.includes("session.set_model"),
                },
                jobs_synced_at: 1,
              },
            ],
            sessions: [
              {
                agent_id: "peer-a",
                session_id: "session-a",
                project: "/work/a",
                name: "Session A",
                started_at: timestamp,
                updated_at: timestamp,
                synced_at: timestamp,
              },
              {
                agent_id: "peer-a",
                session_id: "session-b",
                project: "/work/b",
                name: "Session B",
                started_at: timestamp,
                updated_at: timestamp,
                synced_at: timestamp,
              },
            ],
            jobs:
              scenario === "no-job"
                ? []
                : [
                    {
                      agent_id: "peer-a",
                      job_id:
                        scenario === "replaced" ? "job-model-2" : "job-model",
                      session_id: "session-a",
                      pid: 123,
                      project: "/work/a",
                      created_at: timestamp,
                      state: "running",
                    },
                    ...(scenario === "owner-race"
                      ? [
                          {
                            agent_id: "peer-a",
                            job_id: "job-model-b",
                            session_id: "session-b",
                            pid: 456,
                            project: "/work/b",
                            created_at: timestamp,
                            state: "running",
                          },
                        ]
                      : []),
                  ],
            execution_transport: "confidential",
          }),
        });
        return;
      }
      if (
        request.method() === "GET" &&
        /^\/api\/sessions\/peer-a\/session-(a|b)$/.test(url.pathname) &&
        url.search === "" &&
        request.postData() === null
      ) {
        // Held only in the mismatch phase, so load() can publish the new state
        // while the panel still shows the previous Confirm button.
        if (holdTranscriptA && url.pathname.endsWith("session-a"))
          await transcriptAGate;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            events: [],
            hasEarlier: false,
            total: 0,
            all: false,
            stale: false,
          }),
        });
        return;
      }
      if (
        request.method() === "POST" &&
        url.pathname === "/api/sync" &&
        request.postData() === null
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }
      if (
        request.method() === "GET" &&
        url.pathname === "/api/agents/peer-a/models" &&
        request.postData() === null &&
        ((url.search === "?job_id=job-model" &&
          ["ready", "owner-race", "unusable", "catalog-unavailable"].includes(
            scenario,
          )) ||
          (url.search === "?job_id=job-model-2" && scenario === "replaced") ||
          (url.search === "?job_id=job-model-b" && scenario === "owner-race"))
      ) {
        if (url.search === "?job_id=job-model" && scenario === "owner-race") {
          modelsARequestCount += 1;
          // Gate only the FIRST request: a retry after returning to A must be
          // served immediately while the earlier one is still pending.
          if (modelsARequestCount === 1) {
            modelsAStarted();
            await modelsAGate;
          }
        }
        if (scenario === "unusable") {
          // A catalog with no usable entries is not a working control.
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              models: [{ id: 7, provider: null, name: "" }],
            }),
          });
          return;
        }
        if (scenario === "catalog-unavailable") {
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              code: -32106,
              message: "helper timed out",
            }),
          });
          return;
        }
        const model =
          url.search === "?job_id=job-model-b"
            ? { id: "model-b", provider: "provider-b", name: "Model B" }
            : url.search === "?job_id=job-model-2"
              ? { id: "model-a2", provider: "provider-a", name: "Model A2" }
              : { id: "model-a", provider: "provider-a", name: "Model A" };
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ models: [model] }),
        });
        return;
      }
      if (
        request.method() === "POST" &&
        url.pathname === "/api/agents/peer-a/setmodel" &&
        url.search === "" &&
        request.postData() === JSON.stringify(body) &&
        scenario === "ready"
      ) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            code: -32602,
            message: "Requested provider/model pair is not in the catalog",
          }),
        });
        return;
      }
      fixtureErrors.push(
        `unexpected request ${request.method()} ${url.pathname}${url.search} body=${request.postData()}`,
      );
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "unexpected_request" }),
      });
    });
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByRole("button", { name: /Session A/ }).click();
    const panel = page.locator("#transcript-panel");
    const selector = panel.getByLabel("Available model");
    await expect(
      selector,
      "advertised capability and live job expose agent model catalog",
    ).toBeVisible();
    await expect(selector.locator("option")).toContainText([
      "Choose a model…",
      "Model A (provider-a)",
    ]);
    await selector.selectOption({ label: "Model A (provider-a)" });
    await panel.getByRole("button", { name: "Review model change" }).click();
    await expect(panel).toContainText("Change to Model A (provider-a)?");
    await panel.getByRole("button", { name: "Confirm model change" }).click();
    await expect(panel).toContainText(
      "Agent refusal (-32602): Requested provider/model pair is not in the catalog",
    );

    scenario = "owner-race";
    await page.reload();
    await page.getByRole("button", { name: /Session A/ }).click();
    await modelsAStartedGate;
    await page.getByRole("button", { name: /Session B/ }).click();
    await expect(
      panel
        .getByLabel("Available model")
        .getByRole("option", { name: "Model B (provider-b)" }),
    ).toBeAttached();
    // Back to A while its FIRST catalog request is STILL PENDING. The shared
    // in-flight flag must not block A's retry, and the discarded request must
    // not strand the panel on "Loading…".
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(
      panel
        .getByLabel("Available model")
        .getByRole("option", { name: "Model A (provider-a)" }),
      "returning to A re-fetches while its earlier request is still pending",
    ).toBeAttached();
    // Let the discarded first request settle: it must not clear the newer
    // request's state or blank the catalog the operator is looking at.
    resolveModelsA();
    await expect(
      panel
        .getByLabel("Available model")
        .getByRole("option", { name: "Model A (provider-a)" }),
      "the discarded request does not clobber the newer owner's catalog",
    ).toBeAttached();
    await expect(
      panel
        .getByLabel("Available model")
        .getByRole("option", { name: "Model B (provider-b)" }),
    ).toHaveCount(0);

    // Same page, the running job for this session is REPLACED. A stale catalog
    // or a pending confirmation from the old job would otherwise be sent to the
    // new one.
    scenario = "ready";
    await page.reload();
    await page.getByRole("button", { name: /Session A/ }).click();
    await selector.selectOption({ label: "Model A (provider-a)" });
    await panel.getByRole("button", { name: "Review model change" }).click();
    await expect(panel).toContainText("Change to Model A (provider-a)?");
    scenario = "replaced";
    await page.getByRole("button", { name: "Sync" }).click();
    await expect(
      panel
        .getByLabel("Available model")
        .getByRole("option", { name: "Model A2 (provider-a)" }),
      "a replacement job re-fetches its own catalog",
    ).toBeAttached();
    await expect(
      panel
        .getByLabel("Available model")
        .getByRole("option", { name: "Model A (provider-a)" }),
      "the previous job's catalog is not reused",
    ).toHaveCount(0);
    await expect(
      panel,
      "a pending confirmation from the previous job is cleared",
    ).not.toContainText("Change to Model A (provider-a)?");

    // Confirming in the window where load() has published the new state but the
    // asynchronous transcript refresh has not replaced the old button: the job
    // is already gone, so the explanation must still be rendered, and rendered
    // before the reasons path returns.
    scenario = "ready";
    await page.reload();
    await page.getByRole("button", { name: /Session A/ }).click();
    await selector.selectOption({ label: "Model A (provider-a)" });
    await panel.getByRole("button", { name: "Review model change" }).click();
    await expect(panel).toContainText("Change to Model A (provider-a)?");
    holdTranscriptA = true;
    scenario = "no-job";
    await page.getByRole("button", { name: "Sync" }).click();
    await expect(page.locator("#agents")).toContainText(
      "No jobs reported by the agent.",
    );
    await panel.getByRole("button", { name: "Confirm model change" }).click();
    await expect(
      panel,
      "the mismatch explanation is rendered even when the job is gone",
    ).toContainText(
      "The running job for this session changed; choose a model again.",
    );
    await expect(panel).toContainText(
      "No running job is known for this session.",
    );
    // Publish the replacement state BEFORE releasing the held refresh, so the
    // released refresh renders with the new job rather than the no-job state it
    // was started against. Waiting on the agents panel makes that ordering
    // observable instead of a race with the next Sync.
    scenario = "replaced";
    await page.getByRole("button", { name: "Sync" }).click();
    await expect(page.locator("#agents")).toContainText("job-model-2");
    releaseTranscriptA();
    holdTranscriptA = false;

    // The notice survives the rerender and clears on the operator's next
    // action, leaving no stale warning paragraph in the DOM.
    await expect(
      panel
        .getByLabel("Available model")
        .getByRole("option", { name: "Model A2 (provider-a)" }),
    ).toBeAttached();
    await expect(panel).toContainText(
      "The running job for this session changed; choose a model again.",
    );
    await panel
      .getByLabel("Available model")
      .selectOption({ label: "Model A2 (provider-a)" });
    await panel.getByRole("button", { name: "Review model change" }).click();
    await expect(
      panel,
      "Review clears the mismatch warning rather than leaving it in the DOM",
    ).not.toContainText(
      "The running job for this session changed; choose a model again.",
    );

    // A catalog nobody can choose from says so.
    scenario = "unusable";
    await page.reload();
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(panel).toContainText(
      "The agent reported models, but none with a usable id, provider and name.",
    );
    await expect(panel.getByLabel("Available model")).toHaveCount(0);

    // -32106 is a stated reason, not an empty selector.
    scenario = "catalog-unavailable";
    await page.reload();
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(panel).toContainText("Model catalog unavailable:");
    await expect(panel.getByLabel("Available model")).toHaveCount(0);

    scenario = "no-capability";
    await page.reload();
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(panel).toContainText(
      "This agent does not advertise model changes (session.set_model).",
    );
    await expect(panel.getByLabel("Available model")).toHaveCount(0);

    scenario = "no-job";
    await page.reload();
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(panel).toContainText(
      "No running job is known for this session.",
    );
    await expect(panel.getByLabel("Available model")).toHaveCount(0);
    expect(
      fixtureErrors,
      "model fixture rejects unexpected methods, paths, headers, queries, and bodies",
    ).toEqual([]);
  } finally {
    // Release a still-held route handler so an earlier assertion failure cannot
    // strand this request and hang the teardown.
    releaseTranscriptA();
    await page.close();
    try {
      await control.stop();
    } finally {
      store.close();
    }
  }
});

/**
 * A running session's transcript updates from the SSE stream without a page
 * reload, and token deltas reach the transcript but never the live region.
 */
test("a running session's transcript updates live and announces only boundaries", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Live View Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const { port } = await control.start();
  const token = store.dashboardToken();
  const timestamp = new Date(0).toISOString();
  const page = await browser.newPage();
  let sessionReads = 0;
  try {
    await page.addInitScript(
      (value) => localStorage.setItem("pi_mesh_token", value),
      token,
    );
    // Serve the stream from a ReadableStream the test controls, so the live
    // view stays open while the assertions run. A fulfilled body would end at
    // once and the fallback re-read would wipe the live entry before it could
    // be observed - which is exactly how this test was flaky once.
    await page.addInitScript(`
      (() => {
        const original = window.fetch.bind(window);
        const state = { push: null, close: null, headers: null, url: null };
        window.__m7live = state;
        window.fetch = (input, init) => {
          const url = typeof input === "string" ? input : input.url;
          if (url.includes("/stream")) {
            state.headers = init && init.headers ? init.headers : null;
            state.url = url;
            const encoder = new TextEncoder();
            let sink = null;
            const body = new ReadableStream({
              start(controller) {
                sink = controller;
              },
            });
            state.push = (text) => sink.enqueue(encoder.encode(text));
            state.close = () => sink.close();
            return Promise.resolve(
              new Response(body, {
                status: 200,
                headers: { "content-type": "text/event-stream" },
              }),
            );
          }
          return original(input, init);
        };
      })();
    `);
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/state") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: { id: "control-live", name: "Live View Control" },
            agents: [
              {
                peer_id: "peer-a",
                name: "Agent A",
                host: "127.0.0.1",
                port: 7330,
                paired_at: timestamp,
                skills: ["session.stream"],
                controls: {
                  spawn: false,
                  steer: true,
                  stop: false,
                  abort: false,
                  models: false,
                  setModel: false,
                  resume: false,
                  commands: false,
                  status: false,
                  stream: true,
                },
                jobs_synced_at: 1,
              },
            ],
            sessions: [
              {
                agent_id: "peer-a",
                session_id: "session-a",
                project: "/work/a",
                name: "Session A",
                started_at: timestamp,
                updated_at: timestamp,
                synced_at: timestamp,
              },
            ],
            jobs: [
              {
                agent_id: "peer-a",
                job_id: "job-a",
                session_id: "session-a",
                pid: 1,
                project: "live",
                created_at: timestamp,
                state: "running",
              },
            ],
            execution_transport: "confidential",
          }),
        });
        return;
      }
      if (url.pathname === "/api/sessions/peer-a/session-a") {
        sessionReads += 1;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            events: [
              {
                entry_id: "durable-1",
                timestamp,
                data: JSON.stringify({
                  type: "message",
                  message: {
                    role: "user",
                    content: [{ type: "text", text: "Durable turn" }],
                  },
                }),
              },
            ],
            hasEarlier: false,
            total: 1,
            all: false,
            stale: false,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: "{}",
      });
    });
    await page.goto(`http://127.0.0.1:${port}`);
    await page
      .locator(".session-link")
      .filter({ hasText: "Session A" })
      .click();
    const panel = page.locator("#transcript-panel");
    await expect(panel).toContainText("Durable turn");
    await expect
      .poll(() => page.evaluate("typeof window.__m7live.push"), {
        message: "the live stream request was opened",
      })
      .toBe("function");
    const delta = (text: string) =>
      "event: live\ndata: " +
      JSON.stringify({
        type: "message_update",
        source: "live",
        assistantMessageEvent: { type: "text_delta", delta: text },
      }) +
      "\n\n";
    await page.evaluate(
      `window.__m7live.push(${JSON.stringify(delta("Live hello"))})`,
    );
    await expect(
      panel,
      "the streamed frame appears without a reload",
    ).toContainText("Live hello");
    // A second frame grows the same live entry, still with no reload.
    await page.evaluate(
      `window.__m7live.push(${JSON.stringify(delta(" world"))})`,
    );
    await expect(panel).toContainText("Live hello world");
    // The live region announces entry boundaries, never the tokens themselves.
    await expect(page.locator("#live-status")).not.toContainText("Live hello");
    const request = (await page.evaluate(
      "({ headers: window.__m7live.headers, url: window.__m7live.url })",
    )) as { headers?: Record<string, string> | null; url?: string | null };
    expect(
      (request.headers as Record<string, string>)["X-Pi-Mesh-Ui"],
      "the stream carried the dashboard token",
    ).toBe(token);
    expect(request.url, "no token in the stream URL").not.toContain("token");
    await page.evaluate("window.__m7live.close()");
    await expect(page.locator("#live-status")).toContainText("live view ended");
    await expect
      .poll(() => sessionReads, {
        message: "the durable page is re-read after the stream ends",
      })
      .toBeGreaterThan(1);
  } finally {
    await page.close();
    try {
      await control.stop();
    } finally {
      store.close();
    }
  }
});

test("a not-live stream falls back to the durable page and names the reason", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Not Live Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const { port } = await control.start();
  const token = store.dashboardToken();
  const timestamp = new Date(0).toISOString();
  const page = await browser.newPage();
  try {
    await page.addInitScript(
      (value) => localStorage.setItem("pi_mesh_token", value),
      token,
    );
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/state") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: { id: "control-a", name: "Not Live Control" },
            agents: [
              {
                peer_id: "peer-a",
                name: "Agent A",
                host: "127.0.0.1",
                port: 7330,
                paired_at: timestamp,
                skills: ["session.stream"],
                controls: {
                  spawn: false,
                  steer: false,
                  stop: false,
                  abort: false,
                  models: false,
                  setModel: false,
                  resume: false,
                  commands: false,
                  status: false,
                  stream: true,
                },
                jobs_synced_at: 1,
              },
            ],
            sessions: [
              {
                agent_id: "peer-a",
                session_id: "session-a",
                project: "/work/a",
                name: "Session A",
                started_at: timestamp,
                updated_at: timestamp,
                synced_at: timestamp,
              },
            ],
            jobs: [
              {
                agent_id: "peer-a",
                job_id: "job-a",
                session_id: "session-a",
                pid: 1,
                project: "file",
                created_at: timestamp,
                state: "running",
              },
            ],
            execution_transport: "confidential",
          }),
        });
        return;
      }
      if (url.pathname === "/api/sessions/peer-a/session-a/stream") {
        await route.fulfill({
          contentType: "text/event-stream",
          body:
            "event: not-live\ndata: " +
            JSON.stringify({
              reason: "the agent served the durable file, not a live turn",
            }) +
            "\n\n",
        });
        return;
      }
      if (url.pathname === "/api/sessions/peer-a/session-a") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            events: [
              {
                entry_id: "durable-1",
                timestamp,
                data: JSON.stringify({
                  type: "message",
                  message: {
                    role: "user",
                    content: [{ type: "text", text: "Durable only" }],
                  },
                }),
              },
            ],
            hasEarlier: false,
            total: 1,
            all: false,
            stale: false,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: "{}",
      });
    });
    await page.goto(`http://127.0.0.1:${port}`);
    await page
      .locator(".session-link")
      .filter({ hasText: "Session A" })
      .click();
    const panel = page.locator("#transcript-panel");
    await expect(panel).toContainText("Durable only");
    await expect(
      page.locator("#live-status"),
      "the downgrade is stated, not silent",
    ).toContainText("not live here");
    await expect(page.locator("#live-status")).toContainText("durable file");
    // The durable entry is shown once, and never as a live overlay.
    await expect(panel.locator("text=Durable only")).toHaveCount(1);
    await expect(panel.locator(".live-tail")).toHaveCount(0);
  } finally {
    await page.close();
    try {
      await control.stop();
    } finally {
      store.close();
    }
  }
});

test("a live frame for session A never renders over session B", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Live Ownership Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const { port } = await control.start();
  const token = store.dashboardToken();
  const timestamp = new Date(0).toISOString();
  const page = await browser.newPage();
  let releaseA: () => void = () => undefined;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let aRequested = false;
  const sessions = ["session-a", "session-b"];
  try {
    await page.addInitScript(
      (value) => localStorage.setItem("pi_mesh_token", value),
      token,
    );
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/state") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: { id: "control-a", name: "Live Ownership Control" },
            agents: [
              {
                peer_id: "peer-a",
                name: "Agent A",
                host: "127.0.0.1",
                port: 7330,
                paired_at: timestamp,
                skills: ["session.stream"],
                controls: {
                  spawn: false,
                  steer: false,
                  stop: false,
                  abort: false,
                  models: false,
                  setModel: false,
                  resume: false,
                  commands: false,
                  status: false,
                  stream: true,
                },
                jobs_synced_at: 1,
              },
            ],
            sessions: sessions.map((id) => ({
              agent_id: "peer-a",
              session_id: id,
              project: "/work/a",
              name: id === "session-a" ? "Session A" : "Session B",
              started_at: timestamp,
              updated_at: timestamp,
              synced_at: timestamp,
            })),
            jobs: sessions.map((id) => ({
              agent_id: "peer-a",
              job_id: `job-${id}`,
              session_id: id,
              pid: 1,
              project: "live",
              created_at: timestamp,
              state: "running",
            })),
            execution_transport: "confidential",
          }),
        });
        return;
      }
      if (url.pathname === "/api/sessions/peer-a/session-a/stream") {
        aRequested = true;
        // Held until the test switches to session B, so A's frames arrive late.
        await gateA;
        try {
          await route.fulfill({
            contentType: "text/event-stream",
            body:
              "event: live\ndata: " +
              JSON.stringify({
                type: "message_update",
                source: "live",
                assistantMessageEvent: { type: "text_delta", delta: "LEAKED" },
              }) +
              "\n\n",
          });
        } catch {
          // The browser aborted A's fetch when B was selected; that is the point.
        }
        return;
      }
      if (url.pathname === "/api/sessions/peer-a/session-b/stream") {
        await route.fulfill({
          contentType: "text/event-stream",
          body:
            "event: end\ndata: " +
            JSON.stringify({ reason: "the agent stopped streaming" }) +
            "\n\n",
        });
        return;
      }
      const sessionMatch = url.pathname.match(
        /^\/api\/sessions\/peer-a\/(session-a|session-b)$/,
      );
      if (sessionMatch) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            events: [
              {
                entry_id: `${sessionMatch[1]}-durable`,
                timestamp,
                data: JSON.stringify({
                  type: "message",
                  message: {
                    role: "user",
                    content: [
                      { type: "text", text: `Durable ${sessionMatch[1]}` },
                    ],
                  },
                }),
              },
            ],
            hasEarlier: false,
            total: 1,
            all: false,
            stale: false,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: "{}",
      });
    });
    await page.goto(`http://127.0.0.1:${port}`);
    await page
      .locator(".session-link")
      .filter({ hasText: "Session A" })
      .click();
    await expect.poll(() => aRequested).toBe(true);
    await page
      .locator(".session-link")
      .filter({ hasText: "Session B" })
      .click();
    const panel = page.locator("#transcript-panel");
    await expect(panel).toContainText("Durable session-b");
    releaseA();
    await page.waitForTimeout(300);
    await expect(
      panel,
      "missing observation: a frame for session A must not render over session B",
    ).not.toContainText("LEAKED");
  } finally {
    releaseA();
    await page.close();
    try {
      await control.stop();
    } finally {
      store.close();
    }
  }
});
