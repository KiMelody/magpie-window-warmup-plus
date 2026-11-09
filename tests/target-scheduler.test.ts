// target 触发与验证闭环的调度级测试：复用 scheduler.test.ts 的假时钟 harness 思路，
// 不发任何真实请求。验证读卡走注入的 verifyCardFn，静置时长设 0。
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../src/store";
import { Scheduler, type TaskInput } from "../src/scheduler";
import type { QuotaEntry, RawModel, Run, SendResult, Task } from "../src/types";

process.env.XDG_CONFIG_HOME = join(tmpdir(), "ww-target-test-config");
process.env.XDG_CACHE_HOME = join(tmpdir(), "ww-target-test-cache");

const HOUR = 3_600_000;
const M1: RawModel = { id: "m1", owned_by: "p1", reasoning: false };
const cleanup: string[] = [];
afterEach(async () => { while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true }); });

interface TimerRec { fn: () => void; at: number; cancelled: boolean }
interface SendCall { task: Pick<Task, "id" | "model" | "message" | "maxTokens" | "reasoningEffort">; pin: string | null }

interface Opts {
  startISO: string;
  quotas?: () => QuotaEntry[];
  verifyCard?: (provider: string, account: string) => Promise<QuotaEntry | null>;
  sendImpl?: (call: SendCall) => Promise<SendResult>;
}

async function harness(opts: Opts) {
  const dir = await mkdtemp(join(tmpdir(), "ww-target-"));
  cleanup.push(dir);
  let nowMs = new Date(opts.startISO).getTime();
  const now = () => new Date(nowMs);
  const timers: TimerRec[] = [];
  const setTimer = (fn: () => void, delay: number) => {
    const rec: TimerRec = { fn, at: nowMs + Math.max(0, delay), cancelled: false };
    timers.push(rec);
    return () => { rec.cancelled = true; };
  };
  const fireDue = () => {
    for (let round = 0; round < 5; round++) {
      const due = timers.filter((t) => !t.cancelled && t.at <= nowMs);
      if (!due.length) break;
      for (const t of due) { t.cancelled = true; t.fn(); }
    }
  };
  const sendCalls: SendCall[] = [];
  const sendFn = async (_base: string, task: SendCall["task"], pin: SendCall["pin"]): Promise<SendResult> => {
    const call: SendCall = { task, pin };
    sendCalls.push(call);
    return opts.sendImpl ? opts.sendImpl(call) : { outcome: "ok", reason: "", ms: 2 };
  };
  const quotasFn = async () => ({ at: now(), entries: opts.quotas ? opts.quotas() : [] });
  const store: Store = await openStore(dir);
  const scheduler = new Scheduler({
    store, base: "http://gateway.test", now, setTimer, sendFn,
    modelsFn: async () => [M1],
    quotasFn,
    refreshCardFn: async () => {},
    keyDirFn: async () => null,
    modelCacheFn: async () => null,
    settleMs: 0,
    verifyCardFn: opts.verifyCard ?? (async () => null),
  });
  return {
    scheduler, store, sendCalls, now,
    advance: (d: number) => { nowMs += d; },
    fireDue,
    flush: () => scheduler.flush(),
  };
}

function targetTask(over: Partial<TaskInput> = {}): TaskInput {
  return {
    name: "目标倒推", enabled: true, provider: "openai", account: "acct-1",
    model: "m1", message: "hi",
    trigger: {
      kind: "target", window: "5 hours", timeZone: "UTC", windowHours: 5,
      refreshAfterHours: 2,
      slots: [{ days: [0, 1, 2, 3, 4, 5, 6], useAt: "10:00" }],
    },
    ...over,
  };
}

function card(used: number, resetsAt: string | null, lastServedAt: string | null = null): QuotaEntry {
  return {
    provider: "openai", account: "acct-1", label: "acct-1", viaKey: false,
    windows: [{ name: "5 hours", used, resetsAt }],
    ...(lastServedAt ? { lastServedAt } : {}),
  };
}

test("target：到 sendAt 时发一条消息；招呼语与 maxTokens 透传", async () => {
  // 起点 06:50 UTC，slot 10:00 → sendAt 07:00（+10 分钟到期）
  const h = await harness({ startISO: "2026-11-09T06:50:00Z" });
  await h.scheduler.upsert(targetTask({
    message: "ping", maxTokens: 32, reasoningEffort: "low",
  } as TaskInput));
  h.scheduler.start();
  h.advance(10 * 60_000); // → 07:00
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);
  expect(h.sendCalls[0].task.message).toBe("ping");
  expect(h.sendCalls[0].task.maxTokens).toBe(32);
  expect(h.sendCalls[0].task.reasoningEffort).toBe("low");
  const runs = h.store.data.runs.filter((r) => r.outcome !== "running");
  expect(runs).toHaveLength(1);
  expect(runs[0].slotIndex).toBe(0);
  expect(runs[0].runKey).toBeTruthy();
});

test("target：验证读卡确认 used 增加 → outcome=confirmed", async () => {
  const before = card(3, null);
  const after = card(4, "2026-11-09T12:00:00Z", "2026-11-09T07:00:02Z");
  const h = await harness({
    startISO: "2026-11-09T06:50:00Z",
    quotas: () => [before],
    verifyCard: async () => after,
  });
  await h.scheduler.upsert(targetTask());
  h.scheduler.start();
  h.advance(10 * 60_000);
  h.fireDue();
  await h.flush();
  const run = h.store.data.runs[0];
  expect(run.outcome).toBe("confirmed");
  expect(run.verify?.result).toBe("confirmed");
  expect(run.verify?.signals.join(" ")).toContain("used 3 → 4");
});

test("target：验证读卡无变化 → outcome=no_effect", async () => {
  const same = card(3, null);
  const h = await harness({
    startISO: "2026-11-09T06:50:00Z",
    quotas: () => [same],
    verifyCard: async () => same,
  });
  await h.scheduler.upsert(targetTask());
  h.scheduler.start();
  h.advance(10 * 60_000);
  h.fireDue();
  await h.flush();
  const run = h.store.data.runs[0];
  expect(run.outcome).toBe("no_effect");
  expect(run.verify?.result).toBe("no_effect");
});

test("target：验证读卡失败 → 保留 ok，标 unavailable", async () => {
  const h = await harness({
    startISO: "2026-11-09T06:50:00Z",
    quotas: () => [card(3, null)],
    verifyCard: async () => null,
  });
  await h.scheduler.upsert(targetTask());
  h.scheduler.start();
  h.advance(10 * 60_000);
  h.fireDue();
  await h.flush();
  const run = h.store.data.runs[0];
  expect(run.outcome).toBe("ok");
  expect(run.verify?.result).toBe("unavailable");
});

test("target：发送时刻窗口已开 → 跳过发送，记 no_effect 验证记录", async () => {
  // used>0 且 resetsAt 未到 → 已被手动重置卡或别的请求开过窗
  const opened = card(7, "2026-11-09T12:00:00Z");
  const h = await harness({
    startISO: "2026-11-09T06:50:00Z",
    quotas: () => [opened],
  });
  await h.scheduler.upsert(targetTask());
  h.scheduler.start();
  h.advance(10 * 60_000);
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(0);
  const runs = h.store.data.runs;
  expect(runs).toHaveLength(1);
  expect(runs[0].source).toBe("verify");
  expect(runs[0].outcome).toBe("no_effect");
});

test("target：同一发送时刻不重复处理（targetDone 去重）", async () => {
  const h = await harness({
    startISO: "2026-11-09T06:50:00Z",
    quotas: () => [card(0, null)],
    verifyCard: async () => card(1, "2026-11-09T12:00:00Z"),
  });
  await h.scheduler.upsert(targetTask());
  h.scheduler.start();
  h.advance(10 * 60_000);
  h.fireDue();
  await h.flush();
  const first = h.sendCalls.length;
  // 再推 30 分钟并触发，不应为同一个 sendAt 再发
  h.advance(30 * 60_000);
  h.fireDue();
  await h.flush();
  expect(h.sendCalls.length).toBe(first);
});

test("target：到 resetAt 时检测窗口是否如预期刷新", async () => {
  // 起点 06:50，sendAt 07:00 / useAt 10:00 / resetAt 12:00
  let quotas = [card(3, null)];
  const h = await harness({
    startISO: "2026-11-09T06:50:00Z",
    quotas: () => quotas,
    verifyCard: async () => card(4, "2026-11-09T12:00:00Z"),
  });
  await h.scheduler.upsert(targetTask());
  h.scheduler.start();
  h.advance(10 * 60_000); // → 07:00 发送
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);
  // 到 12:00：卡上 resetsAt 落在预期附近 → 记一条 reset
  quotas = [card(0, "2026-11-09T12:00:00Z")];
  h.advance(5 * HOUR + 10 * 60_000); // 07:00 → 12:10
  h.fireDue();
  await h.flush();
  const resets = h.store.data.runs.filter((r) => r.source === "verify" && r.outcome === "reset");
  expect(resets).toHaveLength(1);
  expect(resets[0].reason).toContain("落在预期");
});

test("target：到 resetAt 但卡上无 resetsAt → 记 missed", async () => {
  const h = await harness({
    startISO: "2026-11-09T06:50:00Z",
    quotas: () => [card(3, null)],
    verifyCard: async () => card(4, null),
  });
  await h.scheduler.upsert(targetTask());
  h.scheduler.start();
  h.advance(10 * 60_000);
  h.fireDue();
  await h.flush();
  h.advance(5 * HOUR + 10 * 60_000);
  h.fireDue();
  await h.flush();
  const missed = h.store.data.runs.filter((r) => r.source === "verify" && r.outcome === "missed");
  expect(missed).toHaveLength(1);
});

test("target：额度卡 user 为空（key 指纹账号）时按 provider 唯一卡兜底验证", async () => {
  // 模拟 zai-2 实况：卡上 user 为空，任务账号是 providers.json 的 key 指纹
  const noUser: QuotaEntry = {
    provider: "openai", account: "", label: "openai", viaKey: false,
    windows: [{ name: "5 hours", used: 3, resetsAt: null }],
  };
  const h = await harness({
    startISO: "2026-11-09T06:50:00Z",
    quotas: () => [noUser],
    verifyCard: async () => ({
      ...noUser,
      windows: [{ name: "5 hours", used: 4, resetsAt: "2026-11-09T12:00:00Z" }],
      lastServedAt: "2026-11-09T07:00:02Z",
    }),
  });
  // 账号用指纹，与卡上 account="" 对不上，必须走 provider 兜底
  await h.scheduler.upsert(targetTask({ account: "53e21fce27" }));
  h.scheduler.start();
  h.advance(10 * 60_000);
  h.fireDue();
  await h.flush();
  expect(h.sendCalls).toHaveLength(1);
  const run = h.store.data.runs[0];
  expect(run.outcome).toBe("confirmed");
});

test("target：静态冲突与最早时间不影响保存（由管理页提示）", async () => {
  const h = await harness({ startISO: "2026-11-09T06:50:00Z" });
  const t = targetTask();
  (t.trigger as { slots: { days: number[]; useAt: string }[] }).slots = [
    { days: [0, 1, 2, 3, 4, 5, 6], useAt: "10:00" },
    { days: [0, 1, 2, 3, 4, 5, 6], useAt: "14:00" },
  ];
  const r = await h.scheduler.upsert(t);
  expect("error" in r).toBe(false);
});
