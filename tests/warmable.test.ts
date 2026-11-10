import { expect, test } from "bun:test";
import { isTimeWindow, providerWarmable } from "../src/accounts";
import type { CatalogProvider, QuotaWindow } from "../src/types";

function win(name: string): QuotaWindow {
  return { name, used: 0, resetsAt: null };
}

function provider(id: string, windowsByAccount: string[][]): CatalogProvider {
  return {
    id,
    accounts: windowsByAccount.map((names, i) => ({
      id: `acct-${i}`, label: `acct-${i}`, kind: "key",
      windows: names.map(win), models: null, perAccount: true, autoModel: null,
    })),
    models: [], autoAccountModels: null, autoModel: null,
  };
}

test("isTimeWindow：订阅时长窗口认得", () => {
  for (const n of [
    "5 hours", "7 days", "Month", "Weekly", "Daily", "monthly", "Cycle",
    "5h", "7d", "2 weeks", "5 小时", "3天", "2周",
  ]) expect(isTimeWindow(n), n).toBe(true);
});

test("isTimeWindow：积分/余额/签到类窗口一律不算", () => {
  for (const n of [
    "Credits", "Total credits", "Add-on credits", "Extra credits", "Dollar Usage",
    "令牌用量", "总积分", "基础积分包", "赠送积分包", "积分余额", "活动积分",
    "每日签到", "每日签到有礼 · 剩 0", "个人体验版 · 剩 500",
    "新用户专属福利 · 剩 3992.77", "MCP · Month（无法解析时长，但同 provider 另有 5 hours）",
    "", "   ",
  ]) expect(isTimeWindow(n), n).toBe(false);
});

test("isTimeWindow：中文时间词必须紧跟数字，裸「每日签到」不得误判", () => {
  expect(isTimeWindow("每日签到")).toBe(false);
  expect(isTimeWindow("3天")).toBe(true);
  expect(isTimeWindow("月")).toBe(false);
  expect(isTimeWindow("Month")).toBe(true);
});

test("providerWarmable：任一账号任一时间窗口即保留（zai-2 真实形态）", () => {
  // zai-2：login 账号有 5 hours + MCP · Month，key 账号窗口为空
  expect(providerWarmable(provider("zai-2", [["MCP · Month", "5 hours"], []]))).toBe(true);
  expect(providerWarmable(provider("opencode-go", [["5 hours", "7 days", "Month"]]))).toBe(true);
});

test("providerWarmable：全是积分/余额窗口或无窗口 → 排除", () => {
  expect(providerWarmable(provider("workbuddy", [["Credits", "Extra credits", "Total credits"]]))).toBe(false);
  expect(providerWarmable(provider("autoclaw", [["每日签到", "积分余额", "活动积分"]]))).toBe(false);
  expect(providerWarmable(provider("codearts", [["总积分", "基础积分包", "赠送积分包"]]))).toBe(false);
  expect(providerWarmable(provider("officeace", [["个人体验版 · 剩 500", "每日签到有礼 · 剩 0"]]))).toBe(false);
  expect(providerWarmable(provider("trae-global", [["Dollar Usage"]]))).toBe(false);
  expect(providerWarmable(provider("cline", [[]]))).toBe(false);
});
