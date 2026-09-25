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
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ results: [] }),
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
        if (
          Object.keys(body).sort().join(",") !== "cwd,project,prompt" &&
          Object.keys(body).sort().join(",") !== "project,prompt"
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
    await reviewStart.click();
    await formA.getByRole("button", { name: "Start", exact: true }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(
      posts[0]?.body,
      "the start request uses the confirmed full project and prompt",
    ).toEqual({ project: "/work/manual", prompt: "first prompt" });
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

    mode = "refusal";
    await formA.getByLabel("Project").fill("/work/refused");
    await formA.getByLabel("Prompt").fill("refused prompt");
    await formA
      .getByLabel("Working directory (optional)")
      .fill("/work/refused-dir");
    await reviewStart.click();
    await expect(
      formA.locator(".start-review"),
      "optional cwd appears in the review before submission",
    ).toContainText(
      "Start one session on Agent A for /work/refused in /work/refused-dir?",
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
      "refused start sends exact project, prompt and optional cwd",
    ).toEqual({
      project: "/work/refused",
      prompt: "refused prompt",
      cwd: "/work/refused-dir",
    });
    await expect(
      formA.getByRole("button", { name: "Start", exact: true }),
    ).toBeEnabled();

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
