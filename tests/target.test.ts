import { describe, expect, test } from "bun:test";
import {
  daysMask, detectConflicts, expandTargetSlots, parseDays, parseHHMM, parseWindowHours,
  pickTargetWindow, type TargetTriggerSpec,
} from "../src/target";

const H = 3_600_000;

function spec(overrides: Partial<TargetTriggerSpec> = {}): TargetTriggerSpec {
  return {
    timeZone: "UTC",
    window: "5 hours",
    windowHours: 5,
    refreshAfterHours: 2,
    slots: [{ days: [0, 1, 2, 3, 4, 5, 6], useAt: "10:00" }],
    ...overrides,
  };
}

describe("parseDays", () => {
  test("别名、范围、通配、数字", () => {
    expect(parseDays("mon-fri")).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays("sat,sun")).toEqual([0, 6]);
    expect(parseDays("*")).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(parseDays("0,2,4")).toEqual([0, 2, 4]);
    expect(parseDays("Mon - Fri")).toEqual([1, 2, 3, 4, 5]);
  });
  test("非法表达式返回 null", () => {
    expect(parseDays("")).toBeNull();
    expect(parseDays("fum")).toBeNull();
    expect(parseDays("fri-mon")).toBeNull();
    expect(parseDays("7")).toBeNull();
    expect(daysMask([1, 2, 3, 4, 5])).toBe(0b0111110);
  });
});

describe("parseHHMM / parseWindowHours", () => {
  test("HH:MM", () => {
    expect(parseHHMM("10:00")).toBe(600);
    expect(parseHHMM("23:59")).toBe(1439);
    expect(parseHHMM("24:00")).toBeNull();
    expect(parseHHMM("10:60")).toBeNull();
  });
  test("窗口名推断长度", () => {
    expect(parseWindowHours("5 hours")).toBe(5);
    expect(parseWindowHours("5h")).toBe(5);
    expect(parseWindowHours("7 days")).toBe(168);
    expect(parseWindowHours("1 week")).toBe(168);
    expect(parseWindowHours("5 小时")).toBe(5);
    expect(parseWindowHours("Month")).toBeNull();
  });
});

describe("expandTargetSlots 倒推公式", () => {
  test("10:00 使用、2h 后刷新、5h 窗口 → 07:00 发送，12:00 重置", () => {
    const from = new Date("2026-11-09T00:00:00.000Z");
    const r = expandTargetSlots(spec(), from, 1);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.slots).toHaveLength(1);
    const s = r.slots[0];
    expect(new Date(s.useAt).toISOString()).toBe("2026-11-09T10:00:00.000Z");
    expect(new Date(s.sendAt).toISOString()).toBe("2026-11-09T07:00:00.000Z");
    expect(new Date(s.resetAt).toISOString()).toBe("2026-11-09T12:00:00.000Z");
  });

  test("跨天：01:00 使用 → 前一天 22:00 发送", () => {
    const from = new Date("2026-11-09T00:00:00.000Z");
    const r = expandTargetSlots(spec({ slots: [{ days: [1], useAt: "01:00" }] }), from, 1);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    const s = r.slots[0];
    expect(new Date(s.sendAt).toISOString()).toBe("2026-11-08T22:00:00.000Z");
    expect(new Date(s.resetAt).toISOString()).toBe("2026-11-09T03:00:00.000Z");
  });

  test("时区：Asia/Singapore 10:00 = UTC 02:00，发送为前一日 23:00 UTC", () => {
    const from = new Date("2026-11-08T00:00:00.000Z");
    const r = expandTargetSlots(spec({ timeZone: "Asia/Singapore" }), from, 3);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    const hit = r.slots.find((s) => new Date(s.useAt).toISOString() === "2026-11-09T02:00:00.000Z");
    expect(hit).toBeDefined();
    if (!hit) return;
    expect(new Date(hit.sendAt).toISOString()).toBe("2026-11-08T23:00:00.000Z");
  });

  test("段级覆盖 Δ：周末 4h 后刷新", () => {
    const from = new Date("2026-11-09T00:00:00.000Z");
    const r = expandTargetSlots(spec({
      slots: [
        { days: [1, 2, 3, 4, 5], useAt: "10:00" },
        { days: [0, 6], useAt: "20:00", refreshAfterHours: 4 },
      ],
    }), from, 7);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    const sat = r.slots.find((s) => s.refreshAfterHours === 4);
    expect(sat).toBeDefined();
    if (!sat) return;
    // 20:00 + 4h − 5h = 19:00 发送，00:00(+1d) 重置
    expect(new Date(sat.sendAt).toISOString().slice(11, 19)).toBe("19:00:00");
    expect(new Date(sat.resetAt).toISOString().slice(11, 19)).toBe("00:00:00");
  });

  test("缺 windowHours 且窗口名无法推断时报错", () => {
    const r = expandTargetSlots(spec({ windowHours: undefined }), new Date("2026-11-09T00:00:00Z"), 1);
    expect("error" in r).toBe(true);
  });
});

describe("detectConflicts 冲突与最早可设时间", () => {
  test("10:00 与 14:00 冲突，最早可设 15:00", () => {
    const from = new Date("2026-11-09T00:00:00.000Z");
    const s = spec({ slots: [
      { days: [1], useAt: "10:00" },
      { days: [1], useAt: "14:00" },
    ] });
    const r = expandTargetSlots(s, from, 1);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    const conflicts = detectConflicts(r.slots, s);
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0];
    expect(c.kind).toBe("overlap");
    expect(new Date(c.earliestUseAt!).toISOString()).toBe("2026-11-09T15:00:00.000Z");
    expect(c.message).toContain("15:00");
  });

  test("两段相隔恰好 L 不冲突", () => {
    const from = new Date("2026-11-09T00:00:00.000Z");
    const s = spec({ slots: [
      { days: [1], useAt: "10:00" },
      { days: [1], useAt: "15:00" },
    ] });
    const r = expandTargetSlots(s, from, 1);
    if ("error" in r) throw new Error(r.error);
    expect(detectConflicts(r.slots, s)).toHaveLength(0);
  });

  test("完全重复判 duplicate 且不给最早时间", () => {
    const from = new Date("2026-11-09T00:00:00.000Z");
    const s = spec({ slots: [
      { days: [1], useAt: "10:00" },
      { days: [1], useAt: "10:00" },
    ] });
    const r = expandTargetSlots(s, from, 1);
    if ("error" in r) throw new Error(r.error);
    const c = detectConflicts(r.slots, s);
    expect(c).toHaveLength(1);
    expect(c[0].kind).toBe("duplicate");
    expect(c[0].earliestUseAt).toBeNull();
  });

  test("Δ 覆盖到 4h 后发送时刻落在已有窗口之外 → 不冲突", () => {
    const from = new Date("2026-11-09T00:00:00.000Z");
    const s = spec({ slots: [
      { days: [1], useAt: "10:00" },
      { days: [1], useAt: "14:00", refreshAfterHours: 4 },
    ] });
    const r = expandTargetSlots(s, from, 1);
    if ("error" in r) throw new Error(r.error);
    // B: send 13:00，晚于 A 的 reset 12:00
    expect(detectConflicts(r.slots, s)).toHaveLength(0);
  });

  test("Δ 覆盖但仍冲突时最早时间用 B 自己的 Δ", () => {
    const from = new Date("2026-11-09T00:00:00.000Z");
    const s = spec({ slots: [
      { days: [1], useAt: "10:00" },
      { days: [1], useAt: "12:00", refreshAfterHours: 4 },
    ] });
    const r = expandTargetSlots(s, from, 1);
    if ("error" in r) throw new Error(r.error);
    const c = detectConflicts(r.slots, s);
    expect(c).toHaveLength(1);
    // B: send 12:00+4h−5h=11:00，落在 A 的 [07:00,12:00) 内 → 冲突
    // R=12:00, L=5, Δ=4 → gap=1h → 最早 13:00
    expect(new Date(c[0].earliestUseAt!).toISOString()).toBe("2026-11-09T13:00:00.000Z");
  });

  test("不同星期不冲突（同一天内不同 days 的展开）", () => {
    const from = new Date("2026-11-09T00:00:00.000Z");
    const s = spec({ slots: [
      { days: [1], useAt: "10:00" },
      { days: [2], useAt: "10:30" },
    ] });
    const r = expandTargetSlots(s, from, 7);
    if ("error" in r) throw new Error(r.error);
    expect(detectConflicts(r.slots, s)).toHaveLength(0);
  });
});

describe("pickTargetWindow", () => {
  test("精确名优先，返回推断长度", () => {
    const r = pickTargetWindow([
      { name: "MCP · Month", used: 2, resetsAt: null, remaining: 98, holdsWhy: null, limit: null },
      { name: "5 hours", used: 3, resetsAt: "2026-11-10T00:49:50Z", remaining: 97, holdsWhy: null, limit: null },
    ], "5 hours");
    expect(r).not.toBeNull();
    expect(r!.hours).toBe(5);
    expect(r!.window.used).toBe(3);
  });
});
