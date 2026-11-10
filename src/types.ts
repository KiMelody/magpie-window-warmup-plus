// 窗口预热插件的共享数据类型，外加各层（含浏览器端页面）都要用的极少量无依赖小工具。

/** 异常转人话原因：Error 取 message，其余原样转字符串 */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 目标时刻倒推的一段配置；days 用 0(周日)..6(周六) */
export interface TargetSlotSpec {
  days: number[];
  useAt: string; // "HH:MM"
  windowHours?: number; // 段级覆盖窗口长度
  refreshAfterHours?: number; // 段级覆盖刷新偏移
}

export type Trigger =
  | { kind: "window"; window: string } // 额度窗口名，如 "5h"
  | { kind: "daily"; time: string; timeZone: string } // "HH:MM" + IANA 时区
  | { kind: "every"; hours: number; anchor: string } // 1–168 小时，anchor 为 ISO 起点
  | {
      /** 按使用时刻倒推发送时刻：T_send = T_use + Δ − L */
      kind: "target";
      window: string; // 额度窗口名，用于读取 L
      timeZone: string;
      windowHours?: number; // 全局 L；留空则从窗口名推断
      refreshAfterHours: number; // 全局 Δ（使用时刻后多久重置）
      slots: TargetSlotSpec[];
    };

export interface Task {
  id: string;
  name: string;
  enabled: boolean;
  provider: string;
  /** key 指纹或订阅账号名，新建/编辑时必填；"" 只会出现在旧版本存下的任务里（发送时不带账号头） */
  account: string;
  /** "" 表示自动选模型：每次发送前按 pickAutoModel 现算，任务里不存选中值 */
  model: string;
  /** 探活消息；旧数据恒为 "hi"，新版允许自定义 */
  message: string;
  /** 探活 max_tokens；旧数据缺省按 16 处理 */
  maxTokens?: number;
  /** 覆盖 pickEffort 的思考档位；缺省为自动 */
  reasoningEffort?: string;
  trigger: Trigger;
  createdAt: string;
  updatedAt: string;
}

/** 验证闭环的判定结果 */
export type Outcome =
  | "ok" // 旧数据：HTTP 200，未验证
  | "confirmed" // 读卡确认窗口已开/已刷新
  | "no_effect" // HTTP 200 但窗口无任何变化
  | "reset" // 检测到窗口重置
  | "missed" // 到点检查未发现预期变化
  | "failed"
  | "unknown";

/** 一次验证读卡的快照（只存判定所需字段，避免 state 膨胀） */
export interface VerifySnapshot {
  used: number | null;
  resetsAt: string | null;
  lastServedAt: string | null;
  readAt: string | null;
}

export interface Verify {
  before: VerifySnapshot;
  after: VerifySnapshot | null;
  signals: string[];
  result: "confirmed" | "no_effect" | "reset" | "missed" | "unavailable" | null;
}

export interface Run {
  id: string;
  taskId: string;
  source: "schedule" | "catchup" | "manual" | "verify";
  due: string | null;
  startedAt: string;
  endedAt: string | null;
  /** "running" 只存在于发送中途的落盘记录 */
  outcome: Outcome | "running";
  /** 失败/未知时必须是人能看懂的中文原因 */
  reason: string;
  /** 当次实际使用的思考档位；模型不思考或不适用时为 null */
  effort: string | null;
  /** 当次实际使用的模型 id；固定模型即任务所配，自动选择即当次选中，解析不出来为 null */
  model: string | null;
  ms: number | null;
  resetKey: string | null;
  /** 幂等标识，超时后据此读卡反查，不盲目重发 */
  runKey?: string;
  /** 发送后读卡验证的快照与结论 */
  verify?: Verify;
  /** 目标时刻段索引；仅 target 触发的 run 有 */
  slotIndex?: number;
}

export type EffortPick = { send: string | null; label: string } | { error: string };

/** send() 的结果；失败/未知时 reason 必须是人能看懂的中文 */
export interface SendResult {
  outcome: Outcome;
  reason: string;
  ms: number;
}

export interface QuotaWindow {
  name: string;
  used: number | null;
  resetsAt: string | null;
  /** 以下为验证闭环与可用窗口判据新增；旧版解析只给前三字段，缺省按 null 处理 */
  remaining?: number | null;
  holdsWhy?: string | null;
  limit?: number | null;
  error?: string | null;
  /** 窗口即将失效/作废的时刻（magpie 的 runsOutAt），非重置时刻 */
  runsOutAt?: string | null;
}

export interface QuotaEntry {
  provider: string;
  account: string;
  label: string;
  windows: QuotaWindow[];
  /** true = 远程 Magpie 给单把 key 发的限额卡（原 provider 形如 "<p>/~keys"，user 是 key 名或打码） */
  viaKey: boolean;
  /** magpie 上次向上游读这张卡的时刻（ISO）；旧版 magpie 不给 */
  readAt?: string;
  /** 该卡最后一次服务时间，用于辅助判定请求是否落到这张卡 */
  lastServedAt?: string | null;
  error?: string | null;
  /** 未来重置计划（magpie 的 resets），非历史记录 */
  resets?: { count: number; until: string | null; byWindow: boolean; each: { until: string; window: string }[] } | null;
}

/** /v1/models 的单条原始对象；档位字段形状随模型而变，使用前需运行时校验 */
export interface RawModel {
  id: string;
  owned_by?: string;
  reasoning?: boolean | string | null;
  reasoning_levels?: string[];
  supported_reasoning_levels?: { effort: string }[];
}

export interface CatalogAccount {
  /** key 账号：key 指纹；订阅账号：额度卡 user */
  id: string;
  /** key 名（没起名用指纹）或账号名 */
  label: string;
  kind: "key" | "login";
  windows: QuotaWindow[];
  /** 该账号可选的模型（/v1/models 的完整 id，升序）；null = 该供应商既无模型缓存、/v1/models 里也没有它的模型 */
  models: string[] | null;
  /** false = 没有模型缓存，models 是该供应商的全部模型（未按账号区分） */
  perAccount: boolean;
  /** 该账号的自动选模型；models 为 null 或空时为 null */
  autoModel: string | null;
}

export interface CatalogModel {
  id: string;
  effort: EffortPick;
}

export interface CatalogProvider {
  id: string;
  accounts: CatalogAccount[];
  models: CatalogModel[];
  /** 「自动选账号」的可选模型（完整 id，升序）；null = 既无模型缓存也无 /v1/models 模型 */
  autoAccountModels: string[] | null;
  /** 「自动选账号」时的自动选模型 */
  autoModel: string | null;
  /** 该供应商有订阅时长窗口、可用于预热；额度快照不可用时一律为 true（避免误清空） */
  warmable?: boolean;
}

/** GET /api/catalog 的响应体 */
export interface Catalog {
  providers: CatalogProvider[];
}
