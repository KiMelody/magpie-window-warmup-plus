// 目标时刻倒推与冲突检测：纯计算，不依赖 node / 网关，页面端也打包本模块。
// 方案约定：T_send = T_use + Δ − L，T_reset = T_use + Δ。
// 其中 Δ=refreshAfterHours（使用时刻后多久重置），L=windowHours（窗口长度）。
import type { QuotaWindow } from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** 展开后的一个目标时刻段（UTC 毫秒时间戳） */
export interface TargetSlot {
  /** 目标使用时刻 */
  useAt: number;
  /** 倒推出的开窗发送时刻 */
  sendAt: number;
  /** 期望的窗口重置时刻 = useAt + Δ */
  resetAt: number;
  /** 段自身的窗口长度（小时），已应用段级覆盖 */
  windowHours: number;
  /** 段自身的刷新偏移（小时），已应用段级覆盖 */
  refreshAfterHours: number;
  /** 该段来自哪个 slot 配置（用于回指 UI 与冲突提示） */
  slotIndex: number;
  /** 星期位掩码，bit0=周日 … bit6=周六，来自 slot.days */
  daysMask: number;
}

/** trigger.kind === "target" 时的一段配置 */
export interface TargetSlotSpec {
  days: number[];
  useAt: string; // "HH:MM"
  /** 段级覆盖；不填则用 trigger 上的全局值 */
  windowHours?: number;
  refreshAfterHours?: number;
}

export interface TargetTriggerSpec {
  timeZone: string;
  window: string;
  windowHours?: number;
  refreshAfterHours?: number;
  slots: TargetSlotSpec[];
}

export type ConflictKind = "overlap" | "sameWindow" | "duplicate";

export interface Conflict {
  kind: ConflictKind;
  /** 冲突双方中「已有」的那一段 */
  otherIndex: number;
  /** 冲突双方中「新加」的那一段 */
  slotIndex: number;
  /** 建议的最早 useAt（UTC 毫秒）；duplicate 时为 null */
  earliestUseAt: number | null;
  /** 面向管理页的中文说明 */
  message: string;
}

const DAY_ALIASES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/** 解析 "mon-fri"、"sat,sun"、"0,1,2" 之类的星期表达式，返回 0(周日)..6(周六) 的集合 */
export function parseDays(input: string): number[] | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s === "*" || s === "all" || s === "daily") return [0, 1, 2, 3, 4, 5, 6];
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const range = /^([a-z]+|\d)\s*-\s*([a-z]+|\d)$/.exec(token);
    if (range) {
      const a = dayNumber(range[1]);
      const b = dayNumber(range[2]);
      if (a === null || b === null || a > b) return null;
      for (let d = a; d <= b; d++) out.add(d);
      continue;
    }
    const single = dayNumber(token);
    if (single === null) return null;
    out.add(single);
  }
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

function dayNumber(token: string): number | null {
  const t = token.trim().toLowerCase();
  if (/^\d$/.test(t)) {
    const n = Number(t);
    return n >= 0 && n <= 6 ? n : null;
  }
  return DAY_ALIASES[t] ?? null;
}

export function daysMask(days: number[]): number {
  let mask = 0;
  for (const d of days) if (d >= 0 && d <= 6) mask |= 1 << d;
  return mask;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 把 "HH:MM" 解析成当天分钟数 */
export function parseHHMM(v: string): number | null {
  const m = HHMM.exec(v);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 从额度卡窗口名推断窗口长度（小时）；解析不出返回 null，由 windowHours 手填兜底 */
export function parseWindowHours(name: string): number | null {
  const s = name.toLowerCase();
  const m = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|小时|时)/.exec(s)
    ?? /(\d+(?:\.\d+)?)\s*(d|day|days|天|日)/.exec(s)
    ?? /(\d+(?:\.\d+)?)\s*(w|week|weeks|周)/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  if (/^(d|day|days|天|日)$/.test(unit)) return n * 24;
  if (/^(w|week|weeks|周)$/.test(unit)) return n * 24 * 7;
  return n;
}

/** 用 IANA 时区把「某天的墙上 HH:MM」换算成 UTC 毫秒；复用 rules.ts 的同款两次修正法 */
function wallToUTC(
  y: number, mo: number, d: number, hh: number, mm: number, timeZone: string,
  offsetAt: (t: number) => number,
): number {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return t;
}

/**
 * 展开未来 days 天内所有段的 send/use/reset 时刻。
 * 跨天由 useAt + Δ − L 自然落到前一天（T_send 可能早于 T_use 所在日）。
 */
export function expandTargetSlots(
  spec: TargetTriggerSpec,
  from: Date,
  days = 7,
  offsetAt?: (t: number) => number,
): { slots: TargetSlot[] } | { error: string; field: string } {
  if (!spec.timeZone || !isValidTimeZone(spec.timeZone)) {
    return { error: "无法识别的时区", field: "timeZone" };
  }
  if (!Array.isArray(spec.slots) || spec.slots.length === 0) {
    return { error: "至少需要一个使用时间段", field: "slots" };
  }
  const globL = spec.windowHours;
  const globD = spec.refreshAfterHours;
  if (globL === undefined || !Number.isFinite(globL) || globL <= 0) {
    return { error: "必须能从额度窗口名推断窗口长度，或填写 windowHours", field: "windowHours" };
  }
  if (globD === undefined || !Number.isFinite(globD) || globD < 0) {
    return { error: "必须填写使用时刻后的刷新偏移 refreshAfterHours", field: "refreshAfterHours" };
  }

  const fmt = offsetAt ?? makeOffsetFn(spec.timeZone);
  const out: TargetSlot[] = [];
  const base = from.getTime();
  for (let day = 0; day < days; day++) {
    // 以 UTC 日期为基准逐日推进，再按时区取该日的星期
    const dayStart = new Date(base + day * DAY_MS);
    const y = dayStart.getUTCFullYear();
    const mo = dayStart.getUTCMonth() + 1;
    const d = dayStart.getUTCDate();
    const noon = Date.UTC(y, mo - 1, d, 12);
    // 该日中午在目标时区里的星期（用墙上日期换算，避免跨日偏移取错）
    const localNoon = noon - fmt(noon);
    const weekday = new Date(localNoon).getUTCDay();
    for (let i = 0; i < spec.slots.length; i++) {
      const s = spec.slots[i];
      const mask = daysMask(s.days);
      if (!(mask & (1 << weekday))) continue;
      const mins = parseHHMM(s.useAt);
      if (mins === null) return { error: "使用时刻需为 24 小时制的 HH:MM", field: `slots[${i}].useAt` };
      const L = s.windowHours ?? globL;
      const D = s.refreshAfterHours ?? globD;
      if (!Number.isFinite(L) || L <= 0) {
        return { error: "窗口长度必须为正数", field: `slots[${i}].windowHours` };
      }
      if (!Number.isFinite(D) || D < 0) {
        return { error: "刷新偏移不能为负数", field: `slots[${i}].refreshAfterHours` };
      }
      const hh = Math.floor(mins / 60);
      const mm = mins % 60;
      const useAt = wallToUTC(y, mo, d, hh, mm, spec.timeZone, fmt);
      out.push({
        useAt,
        sendAt: useAt + D * HOUR_MS - L * HOUR_MS,
        resetAt: useAt + D * HOUR_MS,
        windowHours: L,
        refreshAfterHours: D,
        slotIndex: i,
        daysMask: mask,
      });
    }
  }
  return { slots: out };
}

function makeOffsetFn(timeZone: string): (t: number) => number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  return (t: number) => {
    const p: Record<string, number> = {};
    for (const part of f.formatToParts(new Date(t))) {
      if (part.type !== "literal") p[part.type] = Number(part.value);
    }
    const sec = Math.floor(t / 1000) * 1000;
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - sec;
  };
}

function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/**
 * 冲突检测：只在同一个 (provider, account) 的段之间比较，调用方需按账号分组传入。
 * 判据：段 B 的窗口占用区间 [sendAt_B, resetAt_B) 与段 A 的 [sendAt_A, resetAt_A) 有交叠。
 * 完全重复（sendAt 与 useAt 均相同）单列为 duplicate，硬拒绝。
 * 最早可设 useAt（通用式）：R = 所有已有段 resetAt 的最大值；
 *   useAt_B ≥ R + max(L_B − Δ_B, 0)
 * 当各段 L、Δ 相同且 Δ ≤ L 时简化为 useAt_B ≥ useAt_A + L。
 */
export function detectConflicts(slots: TargetSlot[], spec: TargetTriggerSpec): Conflict[] {
  const out: Conflict[] = [];
  const sorted = [...slots].sort((a, b) => a.sendAt - b.sendAt || a.slotIndex - b.slotIndex);
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    // 判区间交叠：A 的窗口还没结束，B 就已经要开窗了
    const prior = sorted.slice(0, i).filter((p) => p.resetAt > cur.sendAt);
    if (!prior.length) continue;
    const exactDup = prior.find((p) => p.sendAt === cur.sendAt && p.useAt === cur.useAt);
    const kind: ConflictKind = exactDup ? "duplicate" : "overlap";
    const R = Math.max(...prior.map((p) => p.resetAt));
    const gap = Math.max(cur.windowHours - cur.refreshAfterHours, 0) * HOUR_MS;
    const earliestUseAt = kind === "duplicate" ? null : R + gap;
    const l = (t: number) => fmtLocal(t, spec.timeZone);
    const msg = exactDup
      ? `与 ${l(exactDup.useAt)} 的使用段完全重复（同一发送时刻 ${l(cur.sendAt)}），不可保存`
      : `与 ${l(prior[prior.length - 1].useAt)} 的使用段共用同一窗口；最早可设为 ${l(earliestUseAt ?? R)}（当前 ${l(cur.useAt)}）`;
    out.push({
      kind,
      otherIndex: prior[prior.length - 1].slotIndex,
      slotIndex: cur.slotIndex,
      earliestUseAt,
      message: msg,
    });
  }
  return out;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmtLocal(t: number, timeZone: string): string {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("zh-CN", {
      timeZone, hourCycle: "h23",
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    fmtCache.set(timeZone, f);
  }
  return f.format(new Date(t));
}

/** 从额度卡窗口列表里选出目标窗口（优先精确名匹配），返回窗口与推断出的长度 */
export function pickTargetWindow(
  windows: QuotaWindow[],
  name: string,
): { window: QuotaWindow; hours: number | null } | null {
  const exact = windows.find((w) => w.name === name);
  const win = exact ?? windows.find((w) => w.name.toLowerCase().includes(name.toLowerCase()));
  if (!win) return null;
  return { window: win, hours: parseWindowHours(win.name) };
}
