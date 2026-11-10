// 发送前检测目标窗口已开启、顺延到额度卡重置点再发送的调度级测试。
// 复用 target-scheduler.test.ts 的假时钟 harness 思路，不发任何真实请求。
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../src/store";
import { Scheduler, type TaskInput } from "../src/scheduler";
import type { QuotaEntry, RawModel, SendResult, Task } from "../src/types";

process.env.XDG_CONFIG_HOME = join(tmpdir(), "ww-postpone-test-config");
process.env.XDG_CACHE_HOME = join(tmpdir(), "ww-postpone-test-cache");

const HOUR = 3_600_000;
const M1: RawModel = { id: "m1", owned_by: "openai", reasoning: false };
const cleanup: string[] = [];
afterEach(async () => { while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true }); });

interface TimerRec { fn: () => void; at: number; cancelled: boolean }
interface SendCall { task: Pick<Task, "id" | "model" | "message" | "maxTokens" | "reasoningEffort">; pin: string | null }

interface Opts {
  startISO: string;
  quotas?: () => QuotaEntry[];
}

async function harness(opts: Opts) {
  const dir = await mkdtemp(join(tmpdir(), "ww-postpone-"));
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
    sendCalls.push({ task, pin });
    return { outcome: "ok", reason: "", ms: 2 };
  };
  const quotasFn = async () => ({ at: now(), entries: opts.quotas ? opts.quotas() : [] });
  const store: Store = await openStore(dir);
  const makeScheduler = () => new Scheduler({
    store, base: "http://gateway.test", now, setTimer, sendFn,
    modelsFn: async () => [M1],
    quotasFn,
    refreshCardFn: async () => {},
    keyDirFn: async () => null,
    modelCacheFn: async () => null,
    settleMs: 0,
    verifyCardFn: async () => null,
  });
  return {
    store, sendCalls, now, makeScheduler,
    advance: (d: number) => { nowMs += d; },
    /** 推进到指定时刻并触发所有已到期的定时器（真实调度器 10 分钟封顶、醒来重算） */
    to: (iso: string) => { nowMs = new Date(iso).getTime(); fireDue(); },
    fireDue,
  };
}

/** used>0 且 resetsAt 在未来 = 目标窗口已开启 */
function openCard(resetsAt: string, name = "5 hours"): QuotaEntry {
  return {
    provider: "openai", account: "acct-1", label: "acct-1", viaKey: false,
    windows: [{ name, used: 7, resetsAt }],
  };
}

function idleCard(name = "5 hours"): QuotaEntry {
  return {
    provider: "openai", account: "acct-1", label: "acct-1", viaKey: false,
    windows: [{ name, used: 0, resetsAt: null }],
  };
}

function targetTask(over: Partial<TaskInput> = {}): TaskInput {
  return {
    name: "目标倒推", enabled: true, provider: "openai", account: "acct-1",
    model: "m1", message: "hi", postponeIfOpen: true,
    trigger: {
      kind: "target", window: "5 hours", timeZone: "UTC", windowHours: 5,
      refreshAfterHours: 2,
      slots: [{ days: [0, 1, 2, 3, 4, 5, 6], useAt: "10:00" }],
    },
    ...over,
  };
}

function dailyTask(over: Partial<TaskInput> = {}): TaskInput {
  return {
    name: "每天定时", enabled: true, provider: "openai", account: "acct-1",
    model: "m1", message: "hi", postponeIfOpen: true,
    trigger: { kind: "daily", time: "07:00", timeZone: "UTC" },
    ...over,
  };
}

function everyTask(over: Partial<TaskInput> = {}): TaskInput {
  return {
    name: "间隔定时", enabled: true, provider: "openai", account: "acct-1",
    model: "m1", message: "hi", postponeIfOpen: true,
    trigger: { kind: "every", hours: 24, anchor: "2026-11-11T07:00:00.000Z", window: "5 hours" },
    ...over,
  };
}

// 任务在 06:50 建立（updatedAt=06:50），各触发的应到点统一是 07:00。
// 卡上的重置点统一是 12:00（5 小时后、在 24h 与下一个计划点之内）。
const T0 = "2026-11-12T06:50:00Z";
const DUE = "2026-11-12T07:00:00Z";
const RESET = "2026-11-12T12:00:00Z";

test("target：窗口已开启时挂起，到额度卡 resetsAt 才发送一次", async () => {
  const h = await harness({ startISO: T0, quotas: () => [openCard(RESET)] });
  const s = h.makeScheduler();
  const t = await s.upsert(targetTask());
  s.start();
  h.to(DUE);
  await s.flush();
  expect(h.sendCalls).toHaveLength(0);
  expect(h.store.data.marks[t.id].pendingPostpones).toHaveLength(1);
  expect(h.store.data.marks[t.id].pendingPostpones![0].sendAt).toBe(RESET);

  h.to(RESET);
  await s.flush();
  expect(h.sendCalls).toHaveLength(1);
  expect(h.store.data.marks[t.id].pendingPostpones).toHaveLength(0);
  h.to("2026-11-12T12:10:00Z"); // 同一次到期点不会二次顺延
  await s.flush();
  expect(h.sendCalls).toHaveLength(1);
});

test("daily：窗口名留空时自动取第一条时长窗口，已开启则顺延", async () => {
  const h = await harness({ startISO: T0, quotas: () => [openCard(RESET)] });
  const s = h.makeScheduler();
  const t = await s.upsert(dailyTask());
  s.start();
  h.to(DUE);
  await s.flush();
  expect(h.sendCalls).toHaveLength(0);
  expect(h.store.data.marks[t.id].pendingPostpones).toHaveLength(1);
  expect(h.store.data.marks[t.id].pendingPostpones![0].windowName).toBe("5 hours");
  h.to(RESET);
  await s.flush();
  expect(h.sendCalls).toHaveLength(1);
});

test("daily：多条窗口时按填写的窗口名定位", async () => {
  const many: QuotaEntry = {
    provider: "openai", account: "acct-1", label: "acct-1", viaKey: false,
    windows: [
      { name: "5 hours", used: 0, resetsAt: null },
      { name: "7 days", used: 9, resetsAt: RESET },
    ],
  };
  const h = await harness({ startISO: T0, quotas: () => [many] });
  const s = h.makeScheduler();
  const t = await s.upsert(dailyTask({
    trigger: { kind: "daily", time: "07:00", timeZone: "UTC", window: "7 days" },
  }));
  s.start();
  h.to(DUE);
  await s.flush();
  expect(h.sendCalls).toHaveLength(0);
  expect(h.store.data.marks[t.id].pendingPostpones![0].windowName).toBe("7 days");
});

test("every：也走同一套顺延", async () => {
  const h = await harness({ startISO: T0, quotas: () => [openCard(RESET)] });
  const s = h.makeScheduler();
  const t = await s.upsert(everyTask());
  s.start();
  h.to(DUE);
  await s.flush();
  expect(h.sendCalls).toHaveLength(0);
  expect(h.store.data.marks[t.id].pendingPostpones).toHaveLength(1);
  h.to(RESET);
  await s.flush();
  expect(h.sendCalls).toHaveLength(1);
});

test("开关关闭：target 维持原跳过语义、daily 照常发送", async () => {
  const h = await harness({ startISO: T0, quotas: () => [openCard(RESET)] });
  const s = h.makeScheduler();
  const tt = await s.upsert(targetTask({ postponeIfOpen: false }));
  s.start();
  h.to(DUE);
  await s.flush();
  expect(h.sendCalls).toHaveLength(0);
  const skipped = h.store.data.runs.filter((r) => r.source === "verify" && r.outcome === "no_effect");
  expect(skipped).toHaveLength(1);
  expect(h.store.data.marks[tt.id].pendingPostpones ?? []).toHaveLength(0);

  const h2 = await harness({ startISO: T0, quotas: () => [idleCard()] });
  const s2 = h2.makeScheduler();
  await s2.upsert(dailyTask({ postponeIfOpen: false }));
  s2.start();
  h2.to(DUE);
  await s2.flush();
  expect(h2.sendCalls).toHaveLength(1);
});

test("读卡失败 / 无卡：照常发送，不猜刷新时刻", async () => {
  const h = await harness({ startISO: T0, quotas: () => [] });
  const s = h.makeScheduler();
  await s.upsert(dailyTask());
  s.start();
  h.to(DUE);
  await s.flush();
  expect(h.sendCalls).toHaveLength(1);
});

test("服务重启：挂起记录从 state.json 恢复，不重复发送", async () => {
  const h = await harness({ startISO: T0, quotas: () => [openCard(RESET)] });
  const s1 = h.makeScheduler();
  const t = await s1.upsert(targetTask());
  s1.start();
  h.to(DUE);
  await s1.flush();
  expect(h.sendCalls).toHaveLength(0);
  expect(h.store.data.marks[t.id].pendingPostpones).toHaveLength(1);

  s1.stop();
  const s2 = h.makeScheduler(); // 同一 store，模拟重启
  s2.start();
  h.to("2026-11-12T07:05:00Z");
  await s2.flush();
  expect(h.sendCalls).toHaveLength(0); // 还没到重置点
  h.to(RESET);
  await s2.flush();
  expect(h.sendCalls).toHaveLength(1);
});

test("重置点过期超过 6 小时：放弃补发并清理", async () => {
  const h = await harness({ startISO: T0, quotas: () => [openCard(RESET)] });
  const s = h.makeScheduler();
  const t = await s.upsert(targetTask());
  s.start();
  h.to(DUE);
  await s.flush();
  h.to("2026-11-12T19:00:00Z"); // 重置点后 7 小时
  await s.flush();
  expect(h.sendCalls).toHaveLength(0);
  expect(h.store.data.marks[t.id].pendingPostpones).toHaveLength(0);
});

test("刷新点超过 24 小时：放弃顺延并记原因", async () => {
  const h = await harness({
    startISO: T0,
    quotas: () => [openCard("2026-11-14T12:00:00Z")], // 53 小时后
  });
  const s = h.makeScheduler();
  const t = await s.upsert(dailyTask());
  s.start();
  h.to(DUE);
  await s.flush();
  expect(h.sendCalls).toHaveLength(0);
  expect(h.store.data.marks[t.id].pendingPostpones ?? []).toHaveLength(0);
  const noted = h.store.data.runs.filter((r) => r.taskId === t.id && r.reason.includes("超出可用范围"));
  expect(noted.length).toBeGreaterThan(0);
});

test("顺延点晚于下一个计划到期点：放弃本轮（daily）", async () => {
  const h = await harness({
    startISO: T0,
    quotas: () => [openCard("2026-11-13T12:00:00Z")], // 29 小时后，晚于次日 07:00
  });
  const s = h.makeScheduler();
  const t = await s.upsert(dailyTask());
  s.start();
  h.to(DUE);
  await s.flush();
  expect(h.store.data.marks[t.id].pendingPostpones ?? []).toHaveLength(0);
});

test("手动 runNow 不受顺延开关影响", async () => {
  const h = await harness({ startISO: T0, quotas: () => [openCard(RESET)] });
  const s = h.makeScheduler();
  const t = await s.upsert(dailyTask());
  s.start();
  await s.runNow(t.id);
  await s.flush();
  expect(h.sendCalls).toHaveLength(1);
});

test("window 触发开关开启：行为与既有语义一致，不因新字段误挂起", async () => {
  // window 触发本就只在窗口空闲/重置后发，卡已开启时不走到 fire，故不产生挂起
  const h = await harness({ startISO: T0, quotas: () => [openCard(RESET)] });
  const s = h.makeScheduler();
  const t = await s.upsert({
    name: "窗口重置后", enabled: true, provider: "openai", account: "acct-1",
    model: "m1", message: "hi", postponeIfOpen: true,
    trigger: { kind: "window", window: "5 hours" },
  });
  s.start();
  h.to(DUE);
  await s.flush();
  expect(h.store.data.marks[t.id].pendingPostpones ?? []).toHaveLength(0);
});

test("状态总览的 next 指向挂起的顺延点", async () => {
  const h = await harness({ startISO: T0, quotas: () => [openCard(RESET)] });
  const s = h.makeScheduler();
  const t = await s.upsert(targetTask());
  s.start();
  h.to(DUE);
  await s.flush();
  const snap = s.snapshot();
  expect(snap.next[t.id]).toBe(RESET);
  expect(snap.timeline.some((p) => p.taskId === t.id && p.at === RESET)).toBe(true);
});
