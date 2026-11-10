// SPDX-License-Identifier: GPL-3.0-or-later

import { createServer, type Server } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import {
  ControlStore,
  createControlServer,
} from "../packages/control-plane/dist/index.js";

// Session groups default to closed: the scan view is the collapsed list of
// project paths. A session button inside a closed group is not visible, so
// every test that clicks a session first opens the group holding it. The
// subsequent click and every assertion afterwards are unchanged.
async function expandGroup(page: Page, projectPath: string): Promise<void> {
  const group = page
    .locator(
      `#session-list details.session-group:has(> summary[title="${projectPath}"])`,
    )
    .first();
  if ((await group.getAttribute("open")) === null) {
    await group.locator("summary").click();
  }
  await expect(group).toHaveAttribute("open", "");
}

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
    await expandGroup(page, "/work/a");
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(announcement).toHaveText("Loading session session-A.");
    await expandGroup(page, "/work/b");
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
    await expandGroup(page, "/work/a");
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(
      page.getByRole("button", { name: "Load earlier entries" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Load earlier entries" }).click();
    await expandGroup(page, "/work/b");
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
    await expandGroup(page, "/work/a");
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
      await expandGroup(page, "/work/a");
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
      await expandGroup(page, "/work/a");
      await page.getByRole("button", { name: /Session A/ }).click();
      await expect(
        page.getByRole("heading", { name: "Prompt this session" }),
      ).toBeVisible();
    }
    const prompt = page.locator("#transcript-panel");
    await expandGroup(page, "/work/a");
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
    await expandGroup(page, "/work/a");
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(
      page.getByRole("heading", { name: "Prompt this session" }),
    ).toBeVisible();
    const card = page.locator("#transcript-panel");
    const commands = card.locator("details.command-tools");
    await expect(
      commands,
      "command completion starts tucked away",
    ).not.toHaveAttribute("open", "");
    await expect(
      card.locator(".command-list"),
      "no duplicate inline command list",
    ).toHaveCount(0);
    await commands.locator("summary").click();
    const menu = commands.getByLabel("Reported commands");
    await expect(
      menu,
      "the reported names are available WITH their descriptions in the one menu",
    ).toContainText("/fix-tests — Fix failing tests");
    await expect(menu).toContainText("/skill:deploy — Deploy the service");
    const composer = page.getByRole("textbox", { name: "Message to session" });
    // Functional completion: a textarea does not honor `list`, so choosing a
    // reported command must insert it into the draft.
    await composer.fill("");
    await menu.selectOption("/skill:deploy");
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
    await expandGroup(page, "/work/a");
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
    await expandGroup(page, "/work/a");
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
    await expandGroup(page, "/work/a");
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
    await expandGroup(page, "/work/a");
    await page.getByRole("button", { name: /Session A/ }).click();
    const card = page.locator("#transcript-panel");
    await expect(card).toContainText("Model: Model A (provider-a)");
    await expect(
      card.locator(".session-meta summary"),
      "the current model and its picker share one collapsed control",
    ).toHaveText("Model: Model A (provider-a) · Change");
    await expect(card.locator(".session-meta details")).not.toHaveAttribute(
      "open",
      "",
    );
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
    await expandGroup(page, "/work/a");
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
    await expandGroup(page, "/work/a");
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
      await expandGroup(page, "/work/a");
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
    await expandGroup(page, "/work/a");
    await page.getByRole("button", { name: /Session A/ }).click();
    const panel = page.locator("#transcript-panel");
    const modelControl = panel.locator(".session-meta details");
    const openModel = async () => {
      if ((await modelControl.getAttribute("open")) === null)
        await modelControl.locator("summary").click();
    };
    await expect(
      modelControl,
      "model picker starts collapsed",
    ).not.toHaveAttribute("open", "");
    await openModel();
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
    await expandGroup(page, "/work/a");
    await page.getByRole("button", { name: /Session A/ }).click();
    await modelsAStartedGate;
    await expandGroup(page, "/work/b");
    await page.getByRole("button", { name: /Session B/ }).click();
    await expect(
      panel
        .getByLabel("Available model")
        .getByRole("option", { name: "Model B (provider-b)" }),
    ).toBeAttached();
    // Back to A while its FIRST catalog request is STILL PENDING. The shared
    // in-flight flag must not block A's retry, and the discarded request must
    // not strand the panel on "Loading…".
    await expandGroup(page, "/work/a");
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
    await expandGroup(page, "/work/a");
    await page.getByRole("button", { name: /Session A/ }).click();
    await openModel();
    await selector.selectOption({ label: "Model A (provider-a)" });
    await panel.getByRole("button", { name: "Review model change" }).click();
    await expect(panel).toContainText("Change to Model A (provider-a)?");
    scenario = "replaced";
    await page.getByRole("button", { name: "Sync", exact: true }).click();
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
    await expandGroup(page, "/work/a");
    await page.getByRole("button", { name: /Session A/ }).click();
    await openModel();
    await selector.selectOption({ label: "Model A (provider-a)" });
    await panel.getByRole("button", { name: "Review model change" }).click();
    await expect(panel).toContainText("Change to Model A (provider-a)?");
    holdTranscriptA = true;
    scenario = "no-job";
    await page.getByRole("button", { name: "Sync", exact: true }).click();
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
    await page.getByRole("button", { name: "Sync", exact: true }).click();
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
    await expandGroup(page, "/work/a");
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(panel).toContainText(
      "The agent reported models, but none with a usable id, provider and name.",
    );
    await expect(panel.getByLabel("Available model")).toHaveCount(0);

    // -32106 is a stated reason, not an empty selector.
    scenario = "catalog-unavailable";
    await page.reload();
    await expandGroup(page, "/work/a");
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(panel).toContainText("Model catalog unavailable:");
    await expect(panel.getByLabel("Available model")).toHaveCount(0);

    scenario = "no-capability";
    await page.reload();
    await expandGroup(page, "/work/a");
    await page.getByRole("button", { name: /Session A/ }).click();
    await expect(panel).toContainText(
      "This agent does not advertise model changes (session.set_model).",
    );
    await expect(panel.getByLabel("Available model")).toHaveCount(0);

    scenario = "no-job";
    await page.reload();
    await expandGroup(page, "/work/a");
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
  let failRead = false;
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
            state.close = () => { try { sink.close(); } catch { /* already settled */ } };
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
        if (failRead) {
          await route.fulfill({
            status: 502,
            contentType: "application/json",
            body: JSON.stringify({
              error: "agent_unreachable",
              message: "agent is gone",
            }),
          });
          return;
        }
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
    await expandGroup(page, "/work/a");
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
    // Close the stream while the durable re-read will fail: the overlay must
    // still come down, and the failed read must be stated rather than silent.
    failRead = true;
    // An explicit end is terminal: the control plane always writes one before
    // closing, so this is the "view ended" path, not the "connection dropped"
    // path that reconnects.
    await page.evaluate(
      `window.__m7live.push(${JSON.stringify(
        "event: end\ndata: " +
          JSON.stringify({ reason: "the agent stopped streaming" }) +
          "\n\n",
      )})`,
    );
    await page.evaluate("window.__m7live.close()");
    await expect(page.locator("#live-status")).toContainText("live view ended");
    await expect(
      panel.locator(".live-tail"),
      "the overlay is removed even when the durable page cannot be re-read",
    ).toHaveCount(0);
    await expect(page.locator("#transcript-status")).toContainText(
      "could not be re-read",
    );
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
    await expandGroup(page, "/work/a");
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
    await expandGroup(page, "/work/a");
    await page
      .locator(".session-link")
      .filter({ hasText: "Session A" })
      .click();
    await expect.poll(() => aRequested).toBe(true);
    await expandGroup(page, "/work/a");
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

test("an unverified agent's status says the capability is unknown, not absent", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Status Honesty Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const { port } = await control.start();
  const token = store.dashboardToken();
  const timestamp = new Date(0).toISOString();
  const page = await browser.newPage();
  // null is "not verified", which is a different claim from a verified agent
  // whose advertised skill list simply omits session.status.
  let skills: string[] | null = null;
  try {
    await page.addInitScript(
      (value) => localStorage.setItem("pi_mesh_token", value),
      token,
    );
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/state") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: { id: "control-a", name: "Status Honesty Control" },
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
                  steer: false,
                  stop: false,
                  abort: false,
                  models: false,
                  setModel: false,
                  resume: false,
                  commands: false,
                  status: false,
                  stream: false,
                },
                jobs_synced_at: null,
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
            jobs: [],
            execution_transport: "confidential",
          }),
        });
        return;
      }
      if (url.pathname === "/api/sync" && request.method() === "POST") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ results: [] }),
        });
        return;
      }
      if (url.pathname === "/api/sessions/peer-a/session-a") {
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
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: "{}",
      });
    });
    await page.goto(`http://127.0.0.1:${port}`);
    await expandGroup(page, "/work/a");
    await page.locator(".session-link").first().click();
    const card = page.locator("#transcript-panel");
    await expect(
      card,
      "an unverified agent's capability is unknown, not absent",
    ).toContainText(
      "capability unknown because this agent has not been verified",
    );
    // Once verified, the same missing skill is stated as a missing skill.
    skills = ["session.read", "session.list"];
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(
      card,
      "a verified agent that lacks the skill says so",
    ).toContainText("does not advertise session.status");
  } finally {
    await page.close();
    try {
      await control.stop();
    } finally {
      store.close();
    }
  }
});

test("a live view re-attaches after it ends, without re-opening the session", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Live Reattach Control");
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
    await page.addInitScript(`
      (() => {
        const original = window.fetch.bind(window);
        const state = { opens: 0, push: null, close: null };
        window.__m7live = state;
        window.fetch = (input, init) => {
          const url = typeof input === "string" ? input : input.url;
          if (url.includes("/stream")) {
            state.opens += 1;
            const encoder = new TextEncoder();
            let sink = null;
            const body = new ReadableStream({
              start(controller) { sink = controller; },
            });
            state.push = (text) => sink.enqueue(encoder.encode(text));
            state.close = () => { try { sink.close(); } catch { /* already settled */ } };
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
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/state") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            control: { id: "control-a", name: "Live Reattach Control" },
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
      if (url.pathname === "/api/sync" && request.method() === "POST") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ results: [] }),
        });
        return;
      }
      if (url.pathname === "/api/sessions/peer-a/session-a") {
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
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: "{}",
      });
    });
    await page.goto(`http://127.0.0.1:${port}`);
    await expandGroup(page, "/work/a");
    await page.locator(".session-link").first().click();
    await expect
      .poll(() => page.evaluate("window.__m7live.opens"), {
        message: "the first live view opens",
      })
      .toBe(1);
    const delta =
      "event: live\ndata: " +
      JSON.stringify({
        type: "message_update",
        source: "live",
        assistantMessageEvent: { type: "text_delta", delta: "before" },
      }) +
      "\n\n";
    await page.evaluate(`window.__m7live.push(${JSON.stringify(delta)})`);
    await expect(page.locator("#transcript-panel")).toContainText("before");
    // A stated end is terminal: the view does not reconnect by itself, so this
    // isolates the refresh path. Closing without an end frame (a drop) is the
    // separate case the retry test covers.
    await page.evaluate(
      `window.__m7live.push(${JSON.stringify(
        "event: end\ndata: " +
          JSON.stringify({ reason: "the agent stopped streaming" }) +
          "\n\n",
      )})`,
    );
    await page.evaluate("window.__m7live.close()");
    await page.waitForTimeout(300);
    expect(
      await page.evaluate("window.__m7live.opens"),
      "a stated end must not reconnect on its own",
    ).toBe(1);
    // The operator presses Sync; with the job still running, the view re-attaches.
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect
      .poll(() => page.evaluate("window.__m7live.opens"), {
        message:
          "missing observation: the live view re-attached on refresh without re-opening the session",
      })
      .toBe(2);
  } finally {
    await page.close();
    try {
      await control.stop();
    } finally {
      store.close();
    }
  }
});

/** Shared harness for tests that drive the live SSE stream by hand. */
async function mountLiveFixture(
  browser: import("@playwright/test").Browser,
  options: { entries?: number[] } = {},
) {
  const store = new ControlStore(":memory:");
  store.controlName("Live Harness Control");
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const { port } = await control.start();
  const token = store.dashboardToken();
  const timestamp = new Date(0).toISOString();
  const page = await browser.newPage();
  const events = (options.entries ?? []).map((index) => ({
    entry_id: `entry-${index}`,
    timestamp,
    data: JSON.stringify({
      type: "message",
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [
          {
            type: "text",
            text: `Entry number ${index} with enough text to occupy a line or two of the transcript panel.`,
          },
        ],
      },
    }),
  }));
  await page.addInitScript(
    (value) => localStorage.setItem("pi_mesh_token", value),
    token,
  );
  await page.addInitScript(`
    (() => {
      const original = window.fetch.bind(window);
      const state = { opens: 0, push: null, close: null, drop: null };
      window.__live = state;
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("/stream")) {
          state.opens += 1;
          const encoder = new TextEncoder();
          let sink = null;
          const body = new ReadableStream({ start(controller) { sink = controller; } });
          state.push = (text) => sink.enqueue(encoder.encode(text));
          state.close = () => { try { sink.close(); } catch { /* already settled */ } };
          state.drop = () => { try { sink.error(new Error("network")); } catch { /* already settled */ } };
          return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
        }
        return original(input, init);
      };
    })();
  `);
  let syncPosts = 0;
  let listingConfirmed = options.entries === undefined ? true : true;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/state") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          control: { id: "control-a", name: "Live Harness Control" },
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
              jobs_synced_at: listingConfirmed ? 1 : null,
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
    if (url.pathname === "/api/sync" && request.method() === "POST") {
      syncPosts += 1;
      listingConfirmed = true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ results: [] }),
      });
      return;
    }
    if (url.pathname === "/api/sessions/peer-a/session-a") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          events,
          hasEarlier: false,
          total: events.length,
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
  return {
    page,
    base: `http://127.0.0.1:${port}`,
    control,
    store,
    opens: () => page.evaluate("window.__live.opens"),
    syncPosts: () => syncPosts,
    unconfirm: () => {
      listingConfirmed = false;
    },
    metrics: () =>
      page.evaluate(`(() => {
        const list = document.querySelector('#transcript-panel .transcript');
        return list ? { top: list.scrollTop, height: list.scrollHeight, client: list.clientHeight } : null;
      })()`) as Promise<{ top: number; height: number; client: number } | null>,
  };
}

const liveDelta = (text: string) =>
  "event: live\ndata: " +
  JSON.stringify({
    type: "message_update",
    source: "live",
    assistantMessageEvent: { type: "text_delta", delta: text },
  }) +
  "\n\n";

const liveEnd = () =>
  "event: end\ndata: " +
  JSON.stringify({ reason: "the agent stopped streaming" }) +
  "\n\n";

test("a dropped live view reconnects on its own, bounded backoff", async ({
  browser,
}) => {
  const fixture = await mountLiveFixture(browser);
  try {
    await fixture.page.goto(fixture.base);
    await expandGroup(fixture.page, "/work/a");
    await fixture.page.locator(".session-link").first().click();
    await expect
      .poll(fixture.opens, { message: "the first view opens" })
      .toBe(1);
    await fixture.page.evaluate(
      `window.__live.push(${JSON.stringify(liveDelta("hello"))})`,
    );
    await expect(fixture.page.locator("#transcript-panel")).toContainText(
      "hello",
    );
    // A drop: the connection dies with no end frame. No operator action needed.
    await fixture.page.evaluate("window.__live.drop()");
    await expect
      .poll(fixture.opens, {
        timeout: 8000,
        message:
          "missing observation: a dropped live view reconnected without operator action",
      })
      .toBe(2);
    // The reconnect is a new, healthy view.
    await expect(fixture.page.locator("#live-status")).toContainText(
      "Watching this session live",
    );
  } finally {
    await fixture.page.close();
    try {
      await fixture.control.stop();
    } finally {
      fixture.store.close();
    }
  }
});

test("the transcript follows new output and holds position when scrolled up", async ({
  browser,
}) => {
  const fixture = await mountLiveFixture(browser, {
    entries: Array.from({ length: 80 }, (_value, index) => index),
  });
  try {
    await fixture.page.goto(fixture.base);
    await expandGroup(fixture.page, "/work/a");
    await fixture.page.locator(".session-link").first().click();
    await expect
      .poll(fixture.opens, { message: "the live view opens" })
      .toBe(1);
    const atBottom = async () => {
      const m = await fixture.metrics();
      return !!m && m.height - m.top - m.client <= 52;
    };
    await expect
      .poll(atBottom, {
        message: "an opened session starts at the latest entry",
      })
      .toBe(true);
    // Live output follows while the reader is at the bottom.
    await fixture.page.evaluate(
      `window.__live.push(${JSON.stringify(liveDelta("tail-one"))})`,
    );
    await expect(fixture.page.locator("#transcript-panel")).toContainText(
      "tail-one",
    );
    await expect
      .poll(atBottom, { message: "live output keeps the reader at the bottom" })
      .toBe(true);
    // A reader who scrolled up is not yanked down by a refresh...
    await fixture.page.evaluate(`(() => {
      const list = document.querySelector('#transcript-panel .transcript');
      list.scrollTop = 0;
      list.dispatchEvent(new Event('scroll'));
    })()`);
    await fixture.page
      .getByRole("button", { name: "Sync", exact: true })
      .click();
    await fixture.page.waitForTimeout(600);
    const held = await fixture.metrics();
    expect(
      held?.top,
      "a refresh must not throw a reader who scrolled up to the bottom",
    ).toBeLessThan(80);
    // ...but a reader at the bottom stays pinned across a refresh.
    await fixture.page.evaluate(`(() => {
      const list = document.querySelector('#transcript-panel .transcript');
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new Event('scroll'));
    })()`);
    await fixture.page
      .getByRole("button", { name: "Sync", exact: true })
      .click();
    await fixture.page.waitForTimeout(600);
    expect(
      await atBottom(),
      "a refresh must keep a reader who was at the bottom at the bottom",
    ).toBe(true);
    await fixture.page.evaluate(
      `window.__live.push(${JSON.stringify(liveEnd())})`,
    );
    await fixture.page.evaluate("window.__live.close()");
  } finally {
    await fixture.page.close();
    try {
      await fixture.control.stop();
    } finally {
      fixture.store.close();
    }
  }
});

test("sessions sharing a project path group under one collapsible basename header", async ({
  browser,
}) => {
  const store = new ControlStore(":memory:");
  store.controlName("Session Grouping Control");
  const timestamp = new Date(0).toISOString();
  store.upsertAgent({
    peer_id: "peer-a",
    name: "Agent A",
    host: "127.0.0.1",
    port: 1,
    credential: "fixture-credential",
    paired_at: timestamp,
  });
  store.upsertSessions(
    "peer-a",
    [
      {
        id: "aaaaaaaa-1111-2222-3333-444444444444",
        project: "/work/myproj",
        name: "First session",
        started_at: timestamp,
        updated_at: timestamp,
      },
      {
        id: "bbbbbbbb-1111-2222-3333-444444444444",
        project: "/work/myproj",
        started_at: timestamp,
        updated_at: timestamp,
      },
      {
        id: "cccccccc-1111-2222-3333-444444444444",
        project: "/work/other",
        name: "Lone session",
        started_at: timestamp,
        updated_at: timestamp,
      },
    ],
    timestamp,
  );
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  try {
    const { port } = await control.start();
    await page.addInitScript(
      (dashboardToken) => localStorage.setItem("pi_mesh_token", dashboardToken),
      store.dashboardToken(),
    );
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(
      page.getByRole("heading", { name: "Session Grouping Control" }),
    ).toBeVisible();
    const groups = page.locator("#session-list details.session-group");
    await expect(
      groups,
      "two sessions in one project path share a single collapsible group",
    ).toHaveCount(2);
    const myproj = page.locator(
      '#session-list details.session-group:has(summary[title="/work/myproj"])',
    );
    await expect(myproj, "the full path keys exactly one group").toHaveCount(1);
    const header = myproj.locator("summary");
    await expect(header, "the header shows the basename").toContainText(
      "myproj",
    );
    await expect(header, "the header shows the session count").toContainText(
      "2",
    );
    await expect(
      header,
      "the header shows the basename, not the full path",
    ).not.toContainText("/work/myproj");
    await expect(header, "the full path is the header title").toHaveAttribute(
      "title",
      "/work/myproj",
    );
    await expect(myproj, "the group starts closed").not.toHaveAttribute(
      "open",
      "",
    );
    await expect(
      header,
      "the scan view shows the path even while the group is closed",
    ).toBeVisible();
    await expect(
      myproj.getByRole("button", { name: /First session/ }),
      "the scan view shows the path, not the session rows",
    ).not.toBeVisible();
    await expect(
      myproj.getByRole("button", { name: /ago/ }),
      "no session row is visible until the group is opened",
    ).not.toBeVisible();
    await header.click();
    await expect(myproj, "the group expands").toHaveAttribute("open", "");
    await expect(
      myproj.getByRole("button", { name: /First session/ }),
      "a named session keeps its name as the label",
    ).toBeVisible();
    await expect(
      myproj,
      "the unnamed session never reads as only a UUID",
    ).not.toContainText("bbbbbbbb-1111-2222-3333-444444444444");
    await expect(
      myproj.getByRole("button", { name: /ago/ }),
      "the unnamed session falls back to a readable age",
    ).toBeVisible();
    await header.click();
    await expect(myproj, "the group collapses").not.toHaveAttribute("open", "");
    await expect(
      myproj.getByRole("button", { name: /First session/ }),
      "collapsed sessions leave the visible list",
    ).not.toBeVisible();
    await header.click();
    await expect(myproj, "the group expands again").toHaveAttribute("open", "");
    await expect(
      myproj.getByRole("button", { name: /First session/ }),
      "expanded sessions return to the visible list",
    ).toBeVisible();
    await page.locator("#search").fill("first");
    await expect(myproj, "a group matching the search opens").toHaveAttribute(
      "open",
      "",
    );
    await expect(
      groups,
      "the search filters out the non-matching project",
    ).toHaveCount(1);
  } finally {
    await page.close();
    try {
      await control.stop();
    } finally {
      store.close();
    }
  }
});

test("watch delivers a streamed session while sync stays forbidden", async ({
  browser,
}) => {
  // The discriminating clause (ADR 0022): with mesh.watch subscribed, a session
  // created on the agent reaches the dashboard with NO sync call and NO
  // session.list re-list for the duration. Delete the subscription code and the
  // row cannot arrive - the sync fallback is forbidden and the list fallback is
  // failed server-side, so the assertion fails by name rather than by timeout.
  const timestamp = new Date(0).toISOString();
  const project = "/work/watch";
  const seed = (id: string, n: number) => ({
    id,
    project,
    name: `Seed ${n}`,
    started_at: timestamp,
    updated_at: timestamp,
  });
  const sessions = Array.from({ length: 40 }, (_, i) =>
    seed(i === 0 ? "session-a" : `session-seed-${i}`, i),
  );
  const counters = { card: 0, sessionList: 0, processList: 0, streams: 0 };
  let failLists = false;
  const watchPushers: Array<(frame: unknown) => void> = [];
  const stub: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/agent-card.json"
    ) {
      counters.card += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          name: "watch-agent",
          skills: [
            "mesh.watch",
            "session.list",
            "session.read",
            "session.resume",
            "session.steer",
            "process.list",
          ].map((id) => ({ id, name: id, description: "", tags: [] })),
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const rpc = JSON.parse(body) as {
          id: unknown;
          method: string;
          params?: {
            message?: { parts?: Array<{ data?: { skill?: string } }> };
          };
        };
        const reply = (result: unknown): void => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: { message: { parts: [{ data: { result } }] } },
            }),
          );
        };
        const skill = rpc.params?.message?.parts?.[0]?.data?.skill;
        if (rpc.method === "message/send" && skill === "session.list") {
          counters.sessionList += 1;
          if (failLists) {
            response.writeHead(500);
            response.end("listing refused for the duration");
            return;
          }
          reply({ sessions });
          return;
        }
        if (rpc.method === "message/send" && skill === "process.list") {
          counters.processList += 1;
          if (failLists) {
            response.writeHead(500);
            response.end("listing refused for the duration");
            return;
          }
          reply({
            jobs: [
              {
                job_id: "job-a",
                session_id: "session-a",
                pid: 11,
                project,
                state: "running",
                started_at: timestamp,
              },
            ],
          });
          return;
        }
        if (rpc.method === "message/send" && skill === "session.read") {
          reply({ entries: [] });
          return;
        }
        if (rpc.method === "message/stream" && skill === "mesh.watch") {
          counters.streams += 1;
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const send = (payload: unknown): void => {
            if (!response.destroyed)
              response.write(`data: ${JSON.stringify(payload)}\n\n`);
          };
          send({ task: { id: "watch-task" } });
          const push = (frame: unknown): void =>
            send({ message: { parts: [{ data: { result: frame } }] } });
          push({ type: "snapshot", sessions, jobs: [] });
          watchPushers.push(push);
          // The request's close fires when the POST body is consumed, not when
          // the SSE leaves: only the response closing drops the pusher.
          response.once("close", () => {
            const index = watchPushers.indexOf(push);
            if (index !== -1) watchPushers.splice(index, 1);
          });
          return;
        }
        reply({});
      });
      return;
    }
    response.writeHead(404);
    response.end("unknown");
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubPort = (stub.address() as { port: number }).port;
  const store = new ControlStore(":memory:");
  store.controlName("Watch Delivery Control");
  store.upsertAgent({
    peer_id: "peer-watch",
    name: "Watch Agent",
    host: "127.0.0.1",
    port: stubPort,
    credential: Buffer.alloc(32, 5).toString("base64"),
    paired_at: timestamp,
  });
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  let syncCalls = 0;
  let forbidSync = false;
  try {
    const { port } = await control.start();
    const baseURL = `http://127.0.0.1:${port}`;
    const token = store.dashboardToken();
    await page.addInitScript(
      (dashboardToken) => localStorage.setItem("pi_mesh_token", dashboardToken),
      token,
    );
    await page.route("**/api/sync", async (route) => {
      if (route.request().method() === "POST" && forbidSync) {
        syncCalls += 1;
        await route.fulfill({ status: 400, body: "sync forbidden" });
        return;
      }
      await route.continue();
    });
    await page.goto(baseURL);
    await expect(
      page.getByRole("heading", { name: "Watch Delivery Control" }),
    ).toBeVisible();
    // The one allowed sync: it learns the advertisement and starts the held
    // stream. Everything after it runs with the fallbacks forbidden.
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(page.locator("#session-list")).toContainText("Seed 0");
    const live = await page.evaluate(async () => {
      const state = (await (
        await fetch("/api/state", {
          headers: { "X-Pi-Mesh-Ui": localStorage.getItem("pi_mesh_token")! },
        })
      ).json()) as { agents: Array<{ watch: string }> };
      return state.agents[0]?.watch;
    });
    expect(
      live,
      "watch subscription clause: the sync advertisement opens the held stream",
    ).toBe("live");
    expect(counters.streams).toBe(1);
    expect(
      page.locator('[data-sync-agent="peer-watch"]'),
      "the watched agent offers no per-agent sync button",
    ).toHaveCount(0);
    const baselineLists = counters.sessionList;
    // Select a session and leave an unsent draft, with the list scrolled to
    // the bottom: the pushed re-render must keep all three.
    await expandGroup(page, project);
    await page.getByRole("button", { name: /Seed 0/ }).click();
    await expect(
      page.getByRole("heading", { name: "Prompt this session" }),
    ).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Message to session" });
    await composer.fill("unsent draft");
    const listBox = page.locator("#session-list");
    await listBox.evaluate((list) => {
      list.scrollTop = list.scrollHeight;
    });
    const scrolled = await listBox.evaluate((list) => list.scrollTop);
    expect(
      scrolled,
      "positive control: the session list scrolls",
    ).toBeGreaterThan(0);
    // From here the fallbacks are forbidden: the browser sync 400s and counts,
    // and the agent refuses every listing - only a pushed frame can add a row.
    forbidSync = true;
    failLists = true;
    const streamed = {
      id: "session-streamed",
      project,
      name: "Streamed session",
      started_at: timestamp,
      updated_at: timestamp,
    };
    sessions.push(streamed);
    for (const push of [...watchPushers]) {
      push({ type: "added", session: streamed });
    }
    await expect(
      page.locator("#session-list"),
      "watch delivery clause: the streamed session appears with no sync call",
    ).toContainText("Streamed session");
    expect(
      syncCalls,
      "watch delivery clause: no sync call was made for the duration",
    ).toBe(0);
    expect(
      counters.sessionList,
      "watch delivery clause: no session.list re-list ran for the duration",
    ).toBe(baselineLists);
    expect(
      counters.processList,
      "watch delivery clause: no process.list re-list ran for the duration",
    ).toBe(1);
    await expect(
      page.getByRole("heading", { name: "Seed 0" }),
      "watch delivery preserves the selected session",
    ).toBeVisible();
    await expect(
      composer,
      "watch delivery preserves the unsent composer draft",
    ).toHaveValue("unsent draft");
    const kept = await listBox.evaluate((list) => list.scrollTop);
    expect(
      Math.abs(kept - scrolled),
      "watch delivery preserves the list scroll position",
    ).toBeLessThanOrEqual(2);
  } finally {
    await page.close().catch(() => undefined);
    try {
      await control.stop();
    } finally {
      store.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  }
});

test("an agent without mesh.watch keeps a working sync button", async ({
  browser,
}) => {
  // Positive control (ADR 0022 §7): no advertisement means no subscription and
  // the manual path stays offered - the button must still be visible.
  const timestamp = new Date(0).toISOString();
  let streams = 0;
  const stub: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/agent-card.json"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          name: "plain-agent",
          skills: ["session.list", "process.list"].map((id) => ({
            id,
            name: id,
            description: "",
            tags: [],
          })),
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const rpc = JSON.parse(body) as {
          id: unknown;
          method: string;
          params?: {
            message?: { parts?: Array<{ data?: { skill?: string } }> };
          };
        };
        if (rpc.method === "message/stream") {
          streams += 1;
          response.writeHead(400);
          response.end("no watch here");
          return;
        }
        const skill = rpc.params?.message?.parts?.[0]?.data?.skill;
        const result =
          skill === "session.list"
            ? {
                sessions: [
                  {
                    id: "session-plain",
                    project: "/work/plain",
                    name: "Plain session",
                    started_at: timestamp,
                    updated_at: timestamp,
                  },
                ],
              }
            : { jobs: [] };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: { message: { parts: [{ data: { result } }] } },
          }),
        );
      });
      return;
    }
    response.writeHead(404);
    response.end("unknown");
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubPort = (stub.address() as { port: number }).port;
  const store = new ControlStore(":memory:");
  store.controlName("No Watch Control");
  store.upsertAgent({
    peer_id: "peer-plain",
    name: "Plain Agent",
    host: "127.0.0.1",
    port: stubPort,
    credential: Buffer.alloc(32, 6).toString("base64"),
    paired_at: timestamp,
  });
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  try {
    const { port } = await control.start();
    await page.addInitScript(
      (dashboardToken) => localStorage.setItem("pi_mesh_token", dashboardToken),
      store.dashboardToken(),
    );
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(
      page.getByRole("heading", { name: "No Watch Control" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(page.locator("#session-list")).toContainText("Plain session");
    expect(
      streams,
      "capability clause: no stream opens without the advertisement",
    ).toBe(0);
    const state = await page.evaluate(async () => {
      const value = (await (
        await fetch("/api/state", {
          headers: { "X-Pi-Mesh-Ui": localStorage.getItem("pi_mesh_token")! },
        })
      ).json()) as { agents: Array<{ watch: string }> };
      return value.agents[0]?.watch;
    });
    expect(state, "capability clause: the agent reads off, not stale").toBe(
      "off",
    );
    await expect(
      page.locator('[data-sync-agent="peer-plain"]'),
      "the unwatched agent keeps its per-agent sync button",
    ).toBeVisible();
  } finally {
    await page.close().catch(() => undefined);
    try {
      await control.stop();
    } finally {
      store.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  }
});

// A stub agent serving the watch-driven session list. The pushed frames below
// arrive as held-stream deltas, so every list change the tests observe came
// down the watch broadcast rather than a sync or a re-list.
async function startFlickerStub(
  sessions: Array<{
    id: string;
    project: string;
    name?: string;
    started_at: string;
    updated_at: string;
  }>,
) {
  const watchPushers: Array<(frame: unknown) => void> = [];
  const stub: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/agent-card.json"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          name: "flicker-agent",
          skills: [
            "mesh.watch",
            "session.list",
            "session.read",
            "process.list",
          ].map((id) => ({ id, name: id, description: "", tags: [] })),
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const rpc = JSON.parse(body) as {
          id: unknown;
          method: string;
          params?: {
            message?: { parts?: Array<{ data?: { skill?: string } }> };
          };
        };
        const reply = (result: unknown): void => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: { message: { parts: [{ data: { result } }] } },
            }),
          );
        };
        const skill = rpc.params?.message?.parts?.[0]?.data?.skill;
        if (rpc.method === "message/send" && skill === "session.list") {
          reply({ sessions });
          return;
        }
        if (rpc.method === "message/send" && skill === "process.list") {
          reply({ jobs: [] });
          return;
        }
        if (rpc.method === "message/send" && skill === "session.read") {
          reply({ entries: [] });
          return;
        }
        if (rpc.method === "message/stream" && skill === "mesh.watch") {
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const send = (payload: unknown): void => {
            if (!response.destroyed)
              response.write(`data: ${JSON.stringify(payload)}\n\n`);
          };
          send({ task: { id: "watch-task" } });
          const push = (frame: unknown): void =>
            send({ message: { parts: [{ data: { result: frame } }] } });
          push({ type: "snapshot", sessions, jobs: [] });
          watchPushers.push(push);
          response.once("close", () => {
            const index = watchPushers.indexOf(push);
            if (index !== -1) watchPushers.splice(index, 1);
          });
          return;
        }
        reply({});
      });
      return;
    }
    response.writeHead(404);
    response.end("unknown");
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  return { stub, watchPushers };
}

test("a watch refresh keeps the hovered and selected rows as the same nodes", async ({
  browser,
}) => {
  // The flicker clause: with ~15 watch events per second the old list rebuilt
  // every row on every event, destroying the node under the cursor. Here one
  // change for a DIFFERENT session arrives while session A is hovered,
  // selected and text-selected; the row must still be the same connected
  // node afterwards, still hovered, still selected, selection intact.
  const timestamp = new Date(0).toISOString();
  const project = "/work/flicker";
  const sessions = [
    {
      id: "session-a",
      project,
      name: "Session A",
      started_at: timestamp,
      updated_at: timestamp,
    },
    {
      id: "session-b",
      project,
      name: "Session B",
      started_at: timestamp,
      updated_at: timestamp,
    },
  ];
  const { stub, watchPushers } = await startFlickerStub(sessions);
  const stubPort = (stub.address() as { port: number }).port;
  const store = new ControlStore(":memory:");
  store.controlName("Flicker Control");
  store.upsertAgent({
    peer_id: "peer-flicker",
    name: "Flicker Agent",
    host: "127.0.0.1",
    port: stubPort,
    credential: Buffer.alloc(32, 5).toString("base64"),
    paired_at: timestamp,
  });
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  try {
    const { port } = await control.start();
    await page.addInitScript(
      (dashboardToken) => localStorage.setItem("pi_mesh_token", dashboardToken),
      store.dashboardToken(),
    );
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(
      page.getByRole("heading", { name: "Flicker Control" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(page.locator("#session-list")).toContainText("Session A");
    await expandGroup(page, project);
    const rowA = page.getByRole("button", { name: /Session A/ });
    await rowA.click();
    await expect(
      page.getByRole("heading", { name: "Session A" }),
    ).toBeVisible();
    // Hover first: the mouse stays over the row for the rest of the test.
    await rowA.hover();
    expect(
      await rowA.evaluate((el) => el.matches(":hover")),
      "positive control: the row is hovered before the change",
    ).toBe(true);
    const before = await rowA.elementHandle();
    expect(before, "positive control: the row handle exists").not.toBeNull();
    // A text selection inside the row, as an operator copying a session id.
    await page.evaluate(() => {
      const name = document.querySelector(
        'button.session-link[title="session-a"] .session-name',
      );
      const range = document.createRange();
      range.selectNodeContents(name!);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    expect(
      await page.evaluate(() => document.getSelection()?.toString()),
      "positive control: the selection is in the row before the change",
    ).toBe("Session A");
    // A change for a DIFFERENT session: session B is renamed over the watch.
    // The rename keeps the same updated_at, so the recency order is stable
    // and the hovered row has no reason to move: only B's text changes.
    const renamed = {
      id: "session-b",
      project,
      name: "Session B renamed",
      started_at: timestamp,
      updated_at: timestamp,
    };
    sessions[1] = renamed;
    for (const push of [...watchPushers])
      push({ type: "updated", session: renamed });
    await expect(
      page.locator("#session-list"),
      "watch delivery clause: the other session refreshes the list",
    ).toContainText("Session B renamed");
    const connected = await before!.evaluate((el) => el.isConnected);
    expect(
      connected,
      "flicker clause: the hovered row stays connected across a refresh",
    ).toBe(true);
    const same = await before!.evaluate(
      (el) =>
        el === document.querySelector('button.session-link[title="session-a"]'),
    );
    expect(
      same,
      "flicker clause: the hovered row is the same node after a refresh",
    ).toBe(true);
    expect(
      await before!.evaluate((el) => el.matches(":hover")),
      "flicker clause: hover survives the refresh",
    ).toBe(true);
    expect(
      await before!.evaluate((el) => el.getAttribute("aria-current")),
      "flicker clause: the selected row stays selected after a refresh",
    ).toBe("true");
    const selection = await page.evaluate(() => ({
      text: document.getSelection()?.toString() ?? "",
      connected: !!document.getSelection()?.anchorNode?.isConnected,
    }));
    expect(
      selection.text,
      "flicker clause: the text selection survives the refresh",
    ).toBe("Session A");
    expect(
      selection.connected,
      "flicker clause: the selection anchor stays connected",
    ).toBe(true);
  } finally {
    await page.close().catch(() => undefined);
    try {
      await control.stop();
    } finally {
      store.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  }
});

test("a group that disappears does not detach the groups after it", async ({
  browser,
}) => {
  // The placement clause. Placement used to run before the sweep that removes
  // vanished nodes, so a group that was on its way out still sat between two
  // survivors: every node behind it looked out of order and was detached and
  // re-inserted. On the live dashboard that happens ~40 times a second, and a
  // click whose mousedown and mouseup straddle a detach is never dispatched -
  // which is why the disclosure triangles and the session buttons stopped
  // responding while the list looked unchanged.
  const seenAt = (seconds: number): string =>
    new Date(seconds * 1000).toISOString();
  const sessions: Array<{
    id: string;
    project: string;
    name?: string;
    started_at: string;
    updated_at: string;
  }> = [
    {
      id: "session-a",
      project: "/work/alpha",
      name: "A",
      started_at: seenAt(3),
      updated_at: seenAt(3),
    },
    // Sits between alpha and beta while it exists, so it is the stale node that
    // used to invalidate beta's placement anchor.
    {
      id: "session-s",
      project: "/work/zeta",
      name: "S",
      started_at: seenAt(2),
      updated_at: seenAt(2),
    },
    {
      id: "session-b",
      project: "/work/beta",
      name: "B",
      started_at: seenAt(1),
      updated_at: seenAt(1),
    },
  ];
  const { stub, watchPushers } = await startFlickerStub(sessions);
  const stubPort = (stub.address() as { port: number }).port;
  const store = new ControlStore(":memory:");
  store.controlName("Placement Control");
  store.upsertAgent({
    peer_id: "peer-flicker",
    name: "Flicker Agent",
    host: "127.0.0.1",
    port: stubPort,
    credential: Buffer.alloc(32, 5).toString("base64"),
    paired_at: seenAt(0),
  });
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  try {
    const { port } = await control.start();
    await page.addInitScript(
      (dashboardToken) => localStorage.setItem("pi_mesh_token", dashboardToken),
      store.dashboardToken(),
    );
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(page.locator("#session-list")).toContainText("S");
    const beta = page.locator(
      '#session-list details.session-group:has(> summary[title="/work/beta"])',
    );
    const betaHandle = await beta.elementHandle();
    expect(betaHandle, "positive control: beta's group exists").not.toBeNull();
    await page.evaluate(() => {
      const list = document.querySelector("#session-list")!;
      const removed: Node[] = [];
      (window as unknown as { __removed: Node[] }).__removed = removed;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.removedNodes) removed.push(node);
        }
      }).observe(list, { childList: true });
    });
    // Zeta vanishes. Alpha and beta stay, in the same relative order.
    const index = sessions.findIndex((session) => session.id === "session-s");
    sessions.splice(index, 1);
    for (const push of [...watchPushers])
      push({ type: "removed", session_id: "session-s" });
    await expect(page.locator("#session-list")).not.toContainText("/work/zeta");
    const detached = await page.evaluate(() => {
      const removed = (window as unknown as { __removed: Node[] }).__removed;
      return removed.map(
        (node) =>
          (node as Element).querySelector?.("summary")?.getAttribute("title") ??
          null,
      );
    });
    expect(
      detached,
      "placement clause: removal never detaches a surviving group",
    ).toEqual([]);
    expect(
      await betaHandle!.evaluate((el) => el.isConnected),
      "placement clause: beta's group is still the same connected node",
    ).toBe(true);
  } finally {
    await page.close().catch(() => undefined);
    try {
      await control.stop();
    } finally {
      store.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  }
});

test("a burst of watch frames costs far fewer browser refreshes than frames", async ({
  browser,
}) => {
  // The event-rate clause: 20 frames pushed in one tick must not cost 20
  // re-fetches. The server coalesces the burst into one broadcast and the
  // client schedules one refresh per frame; the list still ends up exact.
  const timestamp = new Date(0).toISOString();
  const project = "/work/burst";
  const sessions: Array<{
    id: string;
    project: string;
    name: string;
    started_at: string;
    updated_at: string;
  }> = [
    {
      id: "session-seed",
      project,
      name: "Seed session",
      started_at: timestamp,
      updated_at: timestamp,
    },
  ];
  const { stub, watchPushers } = await startFlickerStub(sessions);
  const stubPort = (stub.address() as { port: number }).port;
  const store = new ControlStore(":memory:");
  store.controlName("Burst Control");
  store.upsertAgent({
    peer_id: "peer-burst",
    name: "Burst Agent",
    host: "127.0.0.1",
    port: stubPort,
    credential: Buffer.alloc(32, 6).toString("base64"),
    paired_at: timestamp,
  });
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  try {
    const { port } = await control.start();
    await page.addInitScript(
      (dashboardToken) => localStorage.setItem("pi_mesh_token", dashboardToken),
      store.dashboardToken(),
    );
    await page.addInitScript(() => {
      (window as unknown as { __stateReads: number }).__stateReads = 0;
      const original = window.fetch.bind(window);
      window.fetch = (async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args);
        try {
          const raw = args[0];
          // A call site may pass a string, a URL, or a Request; only the last
          // two carry .url and URL has it too, so narrow rather than assume.
          const url = new URL(
            typeof raw === "string"
              ? raw
              : raw instanceof URL
                ? raw.href
                : raw.url,
            location.href,
          );
          if (url.pathname === "/api/state")
            (window as unknown as { __stateReads: number }).__stateReads += 1;
        } catch {
          // A relative-URL edge never blocks the wrapped fetch.
        }
        return response;
      }) as typeof fetch;
    });
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(
      page.getByRole("heading", { name: "Burst Control" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(page.locator("#session-list")).toContainText("Seed session");
    await expandGroup(page, project);
    // Let the subscribe-time broadcast flush through, then count only the
    // burst: without the settle, the subscription's own live mark would
    // spend the budget this burst owns.
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      (window as unknown as { __stateReads: number }).__stateReads = 0;
    });
    const burst = Array.from({ length: 20 }, (_, i) => ({
      id: `burst-${i}`,
      project,
      name: `Burst ${i}`,
      started_at: timestamp,
      updated_at: timestamp,
    }));
    sessions.push(...burst);
    for (const session of burst)
      for (const push of [...watchPushers]) push({ type: "added", session });
    await expect(
      page.locator("#session-list"),
      "burst clause: every pushed session lands in the list",
    ).toContainText("Burst 19");
    await expect(
      page.locator("#session-list button.session-link"),
      "burst clause: no rows lost or duplicated",
    ).toHaveCount(21);
    for (const sample of ["burst-0", "burst-7", "burst-19"])
      await expect(
        page.locator(`#session-list button.session-link[title="${sample}"]`),
        `burst clause: ${sample} appears exactly once`,
      ).toHaveCount(1);
    const reads = await page.evaluate(
      () => (window as unknown as { __stateReads: number }).__stateReads,
    );
    expect(
      reads,
      `burst clause: 20 frames in one tick cost far fewer than 20 re-fetches (cost ${reads})`,
    ).toBeLessThanOrEqual(3);
  } finally {
    await page.close().catch(() => undefined);
    try {
      await control.stop();
    } finally {
      store.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  }
});

test("an added session appears and a removed one leaves without rebuilding rows", async ({
  browser,
}) => {
  // The keyed-reuse clause: membership changes insert or remove only their
  // own node. An existing row's handle stays the same connected node across
  // both an add and a remove of other sessions.
  const timestamp = new Date(0).toISOString();
  const project = "/work/membership";
  const sessions: Array<{
    id: string;
    project: string;
    name: string;
    started_at: string;
    updated_at: string;
  }> = [
    {
      id: "session-keep",
      project,
      name: "Kept session",
      started_at: timestamp,
      updated_at: timestamp,
    },
  ];
  const { stub, watchPushers } = await startFlickerStub(sessions);
  const stubPort = (stub.address() as { port: number }).port;
  const store = new ControlStore(":memory:");
  store.controlName("Membership Control");
  store.upsertAgent({
    peer_id: "peer-membership",
    name: "Membership Agent",
    host: "127.0.0.1",
    port: stubPort,
    credential: Buffer.alloc(32, 7).toString("base64"),
    paired_at: timestamp,
  });
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  try {
    const { port } = await control.start();
    await page.addInitScript(
      (dashboardToken) => localStorage.setItem("pi_mesh_token", dashboardToken),
      store.dashboardToken(),
    );
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(
      page.getByRole("heading", { name: "Membership Control" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await expect(page.locator("#session-list")).toContainText("Kept session");
    await expandGroup(page, project);
    const kept = await page
      .getByRole("button", { name: /Kept session/ })
      .elementHandle();
    const added = {
      id: "session-added",
      project,
      name: "Added session",
      started_at: timestamp,
      updated_at: timestamp,
    };
    sessions.push(added);
    for (const push of [...watchPushers])
      push({ type: "added", session: added });
    await expect(
      page.locator("#session-list"),
      "membership clause: the added session appears in its group",
    ).toContainText("Added session");
    expect(
      await kept!.evaluate((el) => el.isConnected),
      "membership clause: an existing row survives an add",
    ).toBe(true);
    expect(
      await kept!.evaluate(
        (el) =>
          el ===
          document.querySelector('button.session-link[title="session-keep"]'),
      ),
      "membership clause: an add does not rebuild an existing row",
    ).toBe(true);
    const addedHandle = await page
      .getByRole("button", { name: /Added session/ })
      .elementHandle();
    const removedIndex = sessions.findIndex(
      (session) => session.id === "session-added",
    );
    sessions.splice(removedIndex, 1);
    for (const push of [...watchPushers])
      push({ type: "removed", id: "session-added" });
    await expect(
      page.locator("#session-list"),
      "membership clause: the removed session disappears",
    ).not.toContainText("Added session");
    await expect(
      page.locator("#session-list"),
      "membership clause: the kept session is still listed",
    ).toContainText("Kept session");
    expect(
      await addedHandle!.evaluate((el) => el.isConnected),
      "membership clause: the removed row is detached",
    ).toBe(false);
    expect(
      await kept!.evaluate((el) => el.isConnected),
      "membership clause: an existing row survives a remove",
    ).toBe(true);
    expect(
      await kept!.evaluate(
        (el) =>
          el ===
          document.querySelector('button.session-link[title="session-keep"]'),
      ),
      "membership clause: a remove does not rebuild an existing row",
    ).toBe(true);
  } finally {
    await page.close().catch(() => undefined);
    try {
      await control.stop();
    } finally {
      store.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  }
});

// M8-7 runs panel: a stub agent whose watch snapshot carries runs and one
// findings pass, like a real agent with a recognised run layout.
interface RunsStubRun {
  run_id: string;
  state: string;
  liveness: {
    state: string;
    reason: string;
    probed_at: string;
    status_age_ms: number;
  };
  pid: number;
  started_at: string;
  last_update: string;
  status_age_ms: number;
  steps: Array<Record<string, unknown>>;
}

function runsStubRun(runId: string, state = "running"): RunsStubRun {
  const now = Date.now();
  return {
    run_id: runId,
    state,
    liveness: {
      state: "alive",
      reason: "pid-alive",
      probed_at: new Date(now - 60_000).toISOString(),
      status_age_ms: 60_000,
    },
    pid: 101,
    started_at: new Date(now - 600_000).toISOString(),
    last_update: new Date(now - 60_000).toISOString(),
    status_age_ms: 60_000,
    steps: [],
  };
}

async function startRunsStub(options: {
  name: string;
  runs: RunsStubRun[];
  evaluatedAt?: string;
  findings?: Array<Record<string, unknown>>;
}) {
  const evaluatedAt =
    options.evaluatedAt ?? new Date(Date.now() - 30_000).toISOString();
  const findings = options.findings ?? [
    {
      rule: "run-stale",
      run_id: options.runs[0]?.run_id ?? "run-1",
      summary: "Run has not updated for a while.",
      observed_at: evaluatedAt,
      actual: 600_000,
      threshold: 300_000,
    },
  ];
  const coverage = {
    layout_recognised: true,
    last_success: evaluatedAt,
    last_error: null,
  };
  const watchPushers: Array<(frame: unknown) => void> = [];
  const stub: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/agent-card.json"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          name: options.name,
          skills: [
            "mesh.watch",
            "session.list",
            "run.list",
            "run.findings",
          ].map((id) => ({ id, name: id, description: "", tags: [] })),
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const rpc = JSON.parse(body) as {
          id: unknown;
          method: string;
          params?: {
            message?: { parts?: Array<{ data?: { skill?: string } }> };
          };
        };
        const reply = (result: unknown): void => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: { message: { parts: [{ data: { result } }] } },
            }),
          );
        };
        const skill = rpc.params?.message?.parts?.[0]?.data?.skill;
        if (rpc.method === "message/send" && skill === "session.list") {
          reply({ sessions: [] });
          return;
        }
        if (rpc.method === "message/send" && skill === "run.list") {
          reply({ runs: options.runs, coverage, evaluated_at: evaluatedAt });
          return;
        }
        if (rpc.method === "message/stream" && skill === "mesh.watch") {
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const send = (payload: unknown): void => {
            if (!response.destroyed)
              response.write(`data: ${JSON.stringify(payload)}\n\n`);
          };
          send({ task: { id: "watch-task" } });
          const push = (frame: unknown): void =>
            send({ message: { parts: [{ data: { result: frame } }] } });
          push({
            type: "snapshot",
            sessions: [],
            jobs: [],
            runs: options.runs,
            findings: { findings, evaluated_at: evaluatedAt, coverage },
          });
          watchPushers.push(push);
          response.once("close", () => {
            const index = watchPushers.indexOf(push);
            if (index !== -1) watchPushers.splice(index, 1);
          });
          return;
        }
        reply({});
      });
      return;
    }
    response.writeHead(404);
    response.end("unknown");
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  return { stub, watchPushers };
}

function runsSection(page: import("@playwright/test").Page, agentName: string) {
  return page.locator("#runs section.agent-section").filter({
    has: page.locator("h2", { hasText: agentName }),
  });
}

test("runs panel lists runs with liveness evidence and findings with coverage and freshness", async ({
  browser,
}) => {
  const timestamp = new Date(0).toISOString();
  const { stub, watchPushers } = await startRunsStub({
    name: "Runs Agent",
    runs: [runsStubRun("run-1")],
  });
  void watchPushers;
  const stubPort = (stub.address() as { port: number }).port;
  const store = new ControlStore(":memory:");
  store.controlName("Runs Control");
  store.upsertAgent({
    peer_id: "peer-runs",
    name: "Runs Agent",
    host: "127.0.0.1",
    port: stubPort,
    credential: Buffer.alloc(32, 7).toString("base64"),
    paired_at: timestamp,
  });
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  try {
    const { port } = await control.start();
    await page.addInitScript(
      (dashboardToken) => localStorage.setItem("pi_mesh_token", dashboardToken),
      store.dashboardToken(),
    );
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(
      page.getByRole("heading", { name: "Runs Control" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    const section = runsSection(page, "Runs Agent");
    // Liveness evidence: state, the pid-liveness tri-state with its reason,
    // the pid, and the age.
    await expect(
      section,
      "runs clause: the run renders with its liveness evidence",
    ).toContainText(
      "run-1 \u2014 running (alive \u00b7 pid-alive) \u00b7 pid 101",
    );
    await expect(
      section,
      "runs clause: the run row states its age",
    ).toContainText("updated");
    await expect(
      section,
      "runs clause: a live watch with a stamped mirror reads live, not cached",
    ).toContainText("runs live");
    await expect(
      section,
      "runs clause: the mirror states its age",
    ).toContainText("Live: mirror updated");
    // Findings with coverage and freshness: the rule, the labelled pass age
    // and the per-agent coverage - never a bare "no findings".
    await expect(
      section,
      "findings clause: the finding renders with its rule",
    ).toContainText("run-stale");
    await expect(
      section,
      "findings clause: the pass states its age and coverage",
    ).toContainText("Evaluated");
    await expect(
      section,
      "findings clause: coverage travels with the findings",
    ).toContainText("layout recognised");
    await expect(
      section,
      "findings clause: an observed pass is not rendered as 'no findings'",
    ).not.toContainText("No findings snapshot observed");
    await expect(
      section,
      "runs clause: a live agent is not rendered as unobserved",
    ).not.toContainText("Unobserved");
  } finally {
    await page.close().catch(() => undefined);
    try {
      await control.stop();
    } finally {
      store.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  }
});

test("a run for agent A never renders under agent B", async ({ browser }) => {
  const timestamp = new Date(0).toISOString();
  const stubA = await startRunsStub({
    name: "Runs Agent A",
    runs: [runsStubRun("run-a1")],
  });
  const stubB = await startRunsStub({
    name: "Runs Agent B",
    runs: [runsStubRun("run-b1")],
  });
  const store = new ControlStore(":memory:");
  store.controlName("Runs Isolation Control");
  store.upsertAgent({
    peer_id: "peer-runs-a",
    name: "Runs Agent A",
    host: "127.0.0.1",
    port: (stubA.stub.address() as { port: number }).port,
    credential: Buffer.alloc(32, 7).toString("base64"),
    paired_at: timestamp,
  });
  store.upsertAgent({
    peer_id: "peer-runs-b",
    name: "Runs Agent B",
    host: "127.0.0.1",
    port: (stubB.stub.address() as { port: number }).port,
    credential: Buffer.alloc(32, 7).toString("base64"),
    paired_at: timestamp,
  });
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  try {
    const { port } = await control.start();
    await page.addInitScript(
      (dashboardToken) => localStorage.setItem("pi_mesh_token", dashboardToken),
      store.dashboardToken(),
    );
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(
      page.getByRole("heading", { name: "Runs Isolation Control" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    const sectionA = runsSection(page, "Runs Agent A");
    const sectionB = runsSection(page, "Runs Agent B");
    await expect(sectionA, "isolation clause: A's run renders").toContainText(
      "run-a1",
    );
    await expect(sectionB, "isolation clause: B's run renders").toContainText(
      "run-b1",
    );
    await expect(
      sectionA,
      "isolation clause: B's run never renders under A",
    ).not.toContainText("run-b1");
    await expect(
      sectionB,
      "isolation clause: A's run never renders under B",
    ).not.toContainText("run-a1");
  } finally {
    await page.close().catch(() => undefined);
    try {
      await control.stop();
    } finally {
      store.close();
      await new Promise<void>((resolve) => stubA.stub.close(() => resolve()));
      await new Promise<void>((resolve) => stubB.stub.close(() => resolve()));
    }
  }
});

test("an agent with no stream renders as unobserved rather than healthy", async ({
  browser,
}) => {
  // A cached run row with a fresh stamp, but no watch subscription: the
  // panel must say unobserved. A stamp alone never renders a row as current.
  const recent = new Date(Date.now() - 30_000).toISOString();
  const store = new ControlStore(":memory:");
  store.controlName("Runs Unobserved Control");
  store.upsertAgent({
    peer_id: "peer-runs-off",
    name: "Offline Agent",
    host: "127.0.0.1",
    port: 1,
    credential: Buffer.alloc(32, 7).toString("base64"),
    paired_at: new Date(0).toISOString(),
  });
  store.replaceRuns(
    "peer-runs-off",
    [
      {
        run_id: "run-cached",
        state: "running",
        liveness: {
          state: "alive",
          reason: "pid-alive",
          probed_at: recent,
          status_age_ms: 1_000,
        },
        started_at: recent,
        last_update: recent,
        status_age_ms: 1_000,
        steps: [],
      },
    ],
    recent,
  );
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  try {
    const { port } = await control.start();
    await page.addInitScript(
      (dashboardToken) => localStorage.setItem("pi_mesh_token", dashboardToken),
      store.dashboardToken(),
    );
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(
      page.getByRole("heading", { name: "Runs Unobserved Control" }),
    ).toBeVisible();
    const section = runsSection(page, "Offline Agent");
    await expect(
      section,
      "unobserved clause: the agent says it is unobserved",
    ).toContainText("Unobserved");
    await expect(
      section,
      "unobserved clause: nothing claims the cached row is current",
    ).not.toContainText("runs live");
    await expect(
      section,
      "unobserved clause: no mirror age is presented as currency",
    ).not.toContainText("Live: mirror updated");
    await expect(
      section,
      "unobserved clause: no observed pass is claimed either",
    ).toContainText("No findings snapshot observed");
  } finally {
    await page.close().catch(() => undefined);
    try {
      await control.stop();
    } finally {
      store.close();
    }
  }
});

test("a runs refresh reuses its rows instead of rebuilding them", async ({
  browser,
}) => {
  // The same clause as the session-list flicker fix, for this view: capture
  // a row's handle, push an update for a DIFFERENT run, and require the
  // handle to still be the same connected node afterwards.
  const timestamp = new Date(0).toISOString();
  const kept = runsStubRun("run-keep");
  const other = runsStubRun("run-other");
  const { stub, watchPushers } = await startRunsStub({
    name: "Runs Reuse Agent",
    runs: [kept, other],
  });
  const stubPort = (stub.address() as { port: number }).port;
  const store = new ControlStore(":memory:");
  store.controlName("Runs Reuse Control");
  store.upsertAgent({
    peer_id: "peer-runs-reuse",
    name: "Runs Reuse Agent",
    host: "127.0.0.1",
    port: stubPort,
    credential: Buffer.alloc(32, 7).toString("base64"),
    paired_at: timestamp,
  });
  const control = createControlServer({ store, host: "127.0.0.1", port: 0 });
  const page = await browser.newPage();
  try {
    const { port } = await control.start();
    await page.addInitScript(
      (dashboardToken) => localStorage.setItem("pi_mesh_token", dashboardToken),
      store.dashboardToken(),
    );
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(
      page.getByRole("heading", { name: "Runs Reuse Control" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    const section = runsSection(page, "Runs Reuse Agent");
    await expect(section, "reuse clause: both runs render").toContainText(
      "run-keep",
    );
    // Run rows live under .job; findings rows are bare .job-line, so the
    // handle below is the run row even though the finding names the run too.
    const row = section.locator(".job > .job-line", { hasText: "run-keep" });
    const before = await row.elementHandle();
    expect(before, "positive control: the row handle exists").not.toBeNull();
    // An update for a DIFFERENT run arrives over the watch.
    for (const push of [...watchPushers])
      push({ type: "run", run: { ...other, state: "complete" } });
    await expect(
      section,
      "reuse clause: the other run's update arrives",
    ).toContainText("run-other \u2014 complete");
    expect(
      await before!.evaluate((el) => el.isConnected),
      "reuse clause: the untouched row stays connected across a refresh (rebuild the rows to fail this)",
    ).toBe(true);
    expect(
      await before!.evaluate(
        (el) =>
          el ===
          [...document.querySelectorAll("#runs .job-line")].find((node) =>
            node.textContent?.includes("run-keep"),
          ),
      ),
      "reuse clause: the untouched row is the same node after a refresh",
    ).toBe(true);
  } finally {
    await page.close().catch(() => undefined);
    try {
      await control.stop();
    } finally {
      store.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  }
});
