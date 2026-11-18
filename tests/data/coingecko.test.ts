import { describe, expect, it } from "vitest";
import { ApiError, CoinGeckoClient, GAP_KEYED, GAP_KEYLESS } from "../../src/data/coingecko";

/** A client on a fake clock: sleeping just moves time forward. Replies come from a script. */
function harness(replies: (url: string, n: number) => Response | Error, key = "") {
  let t = 1_000_000;
  const calls: { url: string; at: number }[] = [];
  const statuses: string[] = [];
  let online = true;
  const client = new CoinGeckoClient({
    getKey: () => key,
    onStatus: s => statuses.push(s),
    now: () => t,
    sleep: async ms => { t += ms; },
    isOnline: () => online,
    fetch: async url => {
      calls.push({ url, at: t });
      const r = replies(url, calls.length);
      if (r instanceof Error) throw r;
      return r;
    },
  });
  return { client, calls, statuses, setOnline: (v: boolean) => { online = v; } };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

describe("CoinGecko client", () => {
  it("adds the Demo key as a query parameter (a header would fail CoinGecko's CORS check)", async () => {
    const h = harness(() => json({ ok: 1 }), "CG-abc");
    await h.client.get("/ping");
    await h.client.get("/search?query=btc");
    expect(h.calls[0].url).toBe("https://api.coingecko.com/api/v3/ping?x_cg_demo_api_key=CG-abc");
    expect(h.calls[1].url).toContain("/search?query=btc&x_cg_demo_api_key=CG-abc");
  });

  it("spaces requests out: wider without a key, narrower with one", async () => {
    for (const [key, gap] of [["", GAP_KEYLESS], ["CG-k", GAP_KEYED]] as const) {
      const h = harness(() => json([]), key);
      await Promise.all([h.client.get("/a"), h.client.get("/b"), h.client.get("/c")]);
      expect(h.calls[1].at - h.calls[0].at).toBeGreaterThanOrEqual(gap);
      expect(h.calls[2].at - h.calls[1].at).toBeGreaterThanOrEqual(gap);
    }
  });

  it("waits and retries after a 429, then widens the spacing", async () => {
    const h = harness((_, n) => (n === 1 ? json({}, 429) : json({ fine: true })));
    const before = h.client.gap();
    await expect(h.client.get("/x")).resolves.toEqual({ fine: true });
    expect(h.calls.length).toBe(2);
    expect(h.calls[1].at - h.calls[0].at).toBeGreaterThanOrEqual(15000);
    expect(h.statuses.some(s => s.includes("rate limit"))).toBe(true);
    expect(h.client.gap()).toBeGreaterThan(before);
  });

  it("treats a network error as a likely throttle and retries", async () => {
    const h = harness((_, n) => (n === 1 ? new TypeError("Failed to fetch") : json(1)));
    await expect(h.client.get("/x")).resolves.toBe(1);
  });

  it("gives up with a clear message when the limit never lifts", async () => {
    const h = harness(() => json({}, 429));
    await expect(h.client.get("/x")).rejects.toMatchObject({ kind: "rate" });
    expect(h.calls.length).toBe(5);
  });

  it("does not retry a rejected key, and recognises a Pro key", async () => {
    const h = harness(() => json({ error: "invalid api key" }, 401), "bad");
    await expect(h.client.get("/x")).rejects.toMatchObject({ kind: "auth" });
    expect(h.calls.length).toBe(1);
    const p = harness(() => json({ status: { error_message: "If you are using Pro API key, please change your root URL from api.coingecko.com to pro-api.coingecko.com" } }, 400), "CG-pro");
    await expect(p.client.get("/x")).rejects.toThrow(/Pro key/);
  });

  it("reports an unknown coin as not found", async () => {
    const h = harness(() => json({ error: "coin not found" }, 404));
    const e = (await h.client.get("/coins/nope/market_chart").catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.kind).toBe("notfound");
  });

  it("fails fast when offline, without calling the network", async () => {
    const h = harness(() => json(1));
    h.setOnline(false);
    await expect(h.client.get("/x")).rejects.toMatchObject({ kind: "offline" });
    expect(h.calls.length).toBe(0);
  });

  it("runs urgent requests first and shares identical ones", async () => {
    const h = harness(url => json(url));
    const order: string[] = [];
    const a = h.client.get("/bg1", 0).then(() => order.push("bg1"));
    const b = h.client.get("/bg2", 0).then(() => order.push("bg2"));
    const c = h.client.get("/search", 10).then(() => order.push("search"));
    const d = h.client.get("/bg2", 0); // same as b: no second request
    await Promise.all([a, b, c, d]);
    expect(order).toEqual(["bg1", "search", "bg2"]); // bg1 was already in flight
    expect(h.calls.length).toBe(3);
  });
});
