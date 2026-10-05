import type { SimulationMode } from "./types";

/** 可扫描的节点字段（与 NodeInspector 中可编辑的数值字段保持一致） */
export type SweepNodeField =
  | "durationMs"
  | "jitterMs"
  | "timeoutMs"
  | "retryCount"
  | "failureRate";

/** 扫描目标：某个请求节点的字段，或整条链路的最大并发 */
export type SweepTarget =
  | { kind: "node"; nodeId: string; field: SweepNodeField }
  | { kind: "concurrency" };

/** 扫描轴：在 [from, to] 区间内按 step 线性取值 */
export interface SweepAxis {
  id: string;
  target: SweepTarget;
  from: number;
  to: number;
  step: number;
}

/** 一次扫描请求：给定完成预算与一到两个参数轴批量推演 */
export interface SweepRequest {
  budgetMs: number;
  mode: SimulationMode;
  axes: [SweepAxis] | [SweepAxis, SweepAxis];
}

export type SweepDirection = "increase" | "decrease";

/** 扫描轴在请求上下文中归一化后的描述信息 */
export interface AxisMeta {
  index: 0 | 1;
  target: SweepTarget;
  label: string;
  unit: string;
  integer: boolean;
  direction: SweepDirection;
  /** 实际参与计算的取值序列（越界并发已裁剪） */
  values: number[];
  /** 取值被裁剪时的提示文案 */
  clampNote?: string;
}

export interface ValidationIssue {
  level: "error" | "warning";
  message: string;
}

export interface SweepValidation {
  errors: string[];
  warnings: string[];
  metas: AxisMeta[];
}

export interface SweepSample {
  values: number[];
  completionMs: number;
  overBudget: boolean;
  /** 相对预算的余量，负数表示已超线（毫秒） */
  headroomMs: number;
  criticalPath: string[];
  /** 各节点结束时间，用于前后对比受影响节点 */
  endMsByNode: Record<string, number>;
  /** 各节点自身建模耗时，用于判断排队还是执行变慢 */
  durationMsByNode: Record<string, number>;
}

/** 临界点两侧的推演结果 */
export interface SweepBracket {
  /** 预算内最后一个采样 */
  inside: SweepSample;
  /** 越线的第一个采样 */
  outside: SweepSample;
  /** 二分细化后的临界参数估计值；整数参数不做细化 */
  threshold?: number;
  /** 阈值是精确二分结果还是按采样步长夹出的区间 */
  precision: "exact" | "bracket";
}

/** 单参数扫描结果 */
export interface OneAxisOutcome {
  kind: "one";
  meta: AxisMeta;
  samples: SweepSample[];
  bracket?: SweepBracket;
  conclusion: "crossed" | "always-inside" | "always-outside";
}

/** 双参数扫描中，随第二轴变化的每一条临界边界行 */
export interface BoundaryRow {
  fixedValue: number;
  bracket?: SweepBracket;
}

/** 双参数扫描结果 */
export interface TwoAxisOutcome {
  kind: "two";
  primary: AxisMeta;
  secondary: AxisMeta;
  samples: SweepSample[];
  boundaries: BoundaryRow[];
  /** 第一个出现越线的越界点（最宽松的越线组合） */
  firstCross?: SweepSample;
  /** 全区间均在预算内的二次轴取值个数 */
  alwaysInsideRows: number;
}

export type SweepOutcome = OneAxisOutcome | TwoAxisOutcome;

export type SweepRunStatus = "completed" | "cancelled";

export interface SweepRunResult {
  status: SweepRunStatus;
  outcome?: SweepOutcome;
  /** 已完成的推演点数 */
  evaluated: number;
  /** 本次扫描的总推演点数 */
  total: number;
}
