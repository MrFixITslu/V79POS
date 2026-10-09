import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");
const helpers = source.slice(source.indexOf('const hubLaunchSessionKey ='), source.indexOf("function renderLogin()"));
const start = source.indexOf('const hubOrigin = "https://hub.v79sl.com";');
const end = source.indexOf('document.addEventListener("submit"', start);
const bootstrap = source.slice(start, end);
if (!helpers.includes("markHubLaunch") || !bootstrap.includes("connectCookie")) throw Error("POS auth bootstrap missing");

type Setup = { hash?: string; marked?: boolean; hasSession?: boolean; exchangeOk?: boolean; opener?: boolean };
function startPos(config: Setup = {}) {
  const calls: string[] = [];
  const root = { innerHTML: "" };
  const store = new Map<string, string>(config.marked ? [["v79-pos-hub-launched", "1"]] : []);
  const history = {
    state: null as any,
    url: "/",
    replaceState(state: any, _unused: string, url?: string) {
      this.state = state;
      if (url) this.url = url;
    },
  };
  const location = { hash: config.hash ?? "", pathname: "/", search: "" };
  const state = { token: "", demo: false, me: null, tenant: "" };
  const opener = config.opener ? { postMessage() {} } : null;
  const handlers: Record<string, (event: any) => void> = {};
  let activeSession = config.hasSession ?? false;
  const context = {
    root, state, location, history, URLSearchParams, sessionStorage: {
      setItem(key: string, value: string) { store.set(key, value); },
      getItem(key: string) { return store.get(key) ?? null; },
    },
    window: {
      opener,
      addEventListener(type: string, callback: (event: any) => void) { handlers[type] = callback; },
    },
    renderLogin() { calls.push("login"); },
    renderConnecting() { calls.push("connecting"); },
    render() { calls.push("dashboard"); },
    toast() {},
    async load() {},
    async api(path: string) {
      if (path !== "/v1/me") throw Error("Unexpected API path");
      if (!activeSession) throw Error("Session expired");
      return { tenantId: "isolated-tenant", roleKey: "MANAGER" };
    },
    async fetch() {
      if (config.exchangeOk === false) return { ok: false, async json() { return { error: "Invalid token" }; } };
      activeSession = true;
      return { ok: true };
    },
  };
  runInNewContext(helpers + "\n" + bootstrap, context);
  return { calls, root, history, store, opener, handlers };
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("POS Hub launch versus direct visitor", () => {
  it("Hub launch succeeds without displaying direct-login panel", async () => {
    const pos = startPos({ hash: "#ticket=synthetic-ticket" });
    await settle();
    expect(pos.calls).toContain("dashboard");
    expect(pos.calls).not.toContain("login");
    expect(pos.history.state?.v79PosHubLaunched).toBe(true);
    expect(pos.store.get("v79-pos-hub-launched")).toBe("1");
    expect(pos.history.url).toBe("/");
  });
  it("Expired Hub launch shows reconnect, never direct-login panel", async () => {
    const pos = startPos({ hash: "#ticket=expired", exchangeOk: false });
    await settle();
    expect(pos.root.innerHTML).toContain("Reconnect through V79 Hub");
    expect(pos.root.innerHTML).toContain("Return to V79 Hub");
    expect(pos.calls).not.toContain("login");
  });
  it("Refreshed Hub tab with expired POS cookie shows reconnect", async () => {
    const pos = startPos({ marked: true, hasSession: false });
    await settle();
    expect(pos.root.innerHTML).toContain("Reconnect through V79 Hub");
    expect(pos.calls).not.toContain("login");
  });
  it("Direct visitor without POS session sees the Hub-managed access page", async () => {
    const pos = startPos({ hasSession: false });
    await settle();
    expect(pos.calls).toContain("login");
    expect(pos.root.innerHTML).not.toContain("Reconnect through V79 Hub");
  });
  it("Direct visitor with an existing POS session goes straight to dashboard", async () => {
    const pos = startPos({ hasSession: true });
    await settle();
    expect(pos.calls).toContain("dashboard");
    expect(pos.calls).not.toContain("login");
  });
  it("Hub popup session failure cannot reveal direct-login panel", async () => {
    const pos = startPos({ opener: true, hasSession: false, exchangeOk: false });
    await settle();
    expect(pos.calls).not.toContain("login");
    pos.handlers.message({
      origin: "https://hub.v79sl.com",
      source: pos.opener,
      data: { type: "v79-pos-auth", accessToken: "synthetic", tenantId: "synthetic" },
    });
    await settle();
    expect(pos.root.innerHTML).toContain("Reconnect through V79 Hub");
    expect(pos.calls).not.toContain("login");
  });
});
