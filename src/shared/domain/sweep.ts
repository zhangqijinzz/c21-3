import { analyzeGraph } from "./graph";
import { simulateProject } from "./simulation";
import type { LatencyProject, RequestNode } from "./types";
import type {
  AxisMeta,
  SweepAxis,
  SweepBracket,
  SweepOutcome,
  SweepRequest,
  SweepSample,
  SweepTarget,
  SweepValidation,
} from "./sweepTypes";

/** 单次扫描允许推演的最大点数，超出直接拒绝，避免界面长时间卡死 */
export const MAX_GRID_POINTS = 2_500;
/** 任一参数轴允许的最大取值个数 */
export const MAX_AXIS_POINTS = 200;
/** 临界值二分细化的最大次数（仅连续参数） */
const MAX_BISECTION_STEPS = 18;
const BISECTION_EPSILON = 0.5;

const FIELD_LABELS: Record<
  Exclude<SweepTarget, { kind: "concurrency" }>["field"],
  string
> = {
  durationMs: "预计耗时",
  jitterMs: "延迟波动",
  timeoutMs: "超时阈值",
  retryCount: "重试次数",
  failureRate: "失败概率",
};

const FIELD_UNITS: Record<
  Exclude<SweepTarget, { kind: "concurrency" }>["field"],
  string
> = {
  durationMs: "ms",
  jitterMs: "ms",
  timeoutMs: "ms",
  retryCount: "次",
  failureRate: "%",
};

const INTEGER_FIELDS = new Set(["retryCount"]);

export function targetLabel(target: SweepTarget, nodes: RequestNode[]): string {
  if (target.kind === "concurrency") return "最大并发";
  const node = nodes.find((item) => item.id === target.nodeId);
  const nodeName = node?.name ?? target.nodeId;
  return `${nodeName} · ${FIELD_LABELS[target.field]}`;
}

export function targetUnit(target: SweepTarget): string {
  return target.kind === "concurrency" ? "路" : FIELD_UNITS[target.field];
}

export function isIntegerTarget(target: SweepTarget): boolean {
  return target.kind === "concurrency" || (target.kind === "node" && INTEGER_FIELDS.has(target.field));
}

/** 生成 [min(from,to), max(from,to)] 闭区间内按 step 递增的取值序列 */
export function axisValues(axis: SweepAxis, integer: boolean): number[] {
  const start = Math.min(axis.from, axis.to);
  const end = Math.max(axis.from, axis.to);
  const span = end - start;
  const count = Math.round(span / axis.step);
  const values: number[] = [];
  for (let i = 0; i <= count; i += 1) {
    let value = start + axis.step * i;
    // 修正浮点尾差，保证最后一个点恰好落在终点
    if (i === count) value = end;
    values.push(integer ? Math.round(value) : Math.round(value * 1000) / 1000);
  }
  return [...new Set(values)];
}

/** 把扫描参数应用到项目副本上 */
export function projectAtSweepPoint(
  project: LatencyProject,
  axes: SweepAxis[],
  values: number[],
): LatencyProject {
  return applyTargets(project, axes, values);
}

function applyTargets(
  project: LatencyProject,
  axes: SweepAxis[],
  values: number[],
): LatencyProject {
  let concurrencyLimit = project.concurrencyLimit;
  const patches = new Map<string, Partial<RequestNode>>();
  axes.forEach((axis, index) => {
    const value = values[index];
    if (value === undefined) return;
    if (axis.target.kind === "concurrency") {
      concurrencyLimit = value;
    } else {
      const { nodeId, field } = axis.target;
      patches.set(nodeId, { ...patches.get(nodeId), [field]: value });
    }
  });
  return {
    ...project,
    concurrencyLimit,
    nodes: project.nodes.map((node) => {
      const patch = patches.get(node.id);
      return patch ? { ...node, ...patch } : node;
    }),
  };
}

function evaluate(
  project: LatencyProject,
  axes: SweepAxis[],
  values: number[],
  mode: SweepRequest["mode"],
  budgetMs: number,
): SweepSample {
  const candidate = applyTargets(project, axes, values);
  const result = simulateProject(candidate, mode);
  const completionMs = result.completionMs;
  const endMsByNode: Record<string, number> = {};
  const durationMsByNode: Record<string, number> = {};
  for (const entry of result.entries) {
    endMsByNode[entry.nodeId] = entry.endMs;
    durationMsByNode[entry.nodeId] = entry.modeledDurationMs;
  }
  return {
    values: [...values],
    completionMs,
    overBudget: completionMs > budgetMs,
    headroomMs: budgetMs - completionMs,
    criticalPath: [...result.criticalPath],
    endMsByNode,
    durationMsByNode,
  };
}

/**
 * 校验扫描请求。区间写反、步长非法、规模过大、目标失效、链路本身有错
 * 都会转成人能读懂的中文反馈。
 */
export function validateSweep(
  project: LatencyProject,
  request: SweepRequest,
): SweepValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const nodeIds = new Set(project.nodes.map((node) => node.id));

  const graphErrors = analyzeGraph(project).validation.errors;
  if (graphErrors.length) {
    errors.push(
      `当前链路存在配置问题，请先修复后再扫描：${graphErrors[0] ?? ""}`,
    );
  }
  if (!(request.budgetMs > 0) || !Number.isFinite(request.budgetMs))
    errors.push("目标完成时间需要是大于 0 的毫秒数。");
  if (request.axes.length < 1 || request.axes.length > 2)
    errors.push("扫描需要选择一到两个参数。");

  const targets = request.axes.map((axis) => axis.target);
  const targetKeys = targets.map((target) =>
    target.kind === "concurrency"
      ? "concurrency"
      : `${target.nodeId}:${target.field}`,
  );
  if (new Set(targetKeys).size !== targetKeys.length)
    errors.push("两个扫描参数不能是同一个字段，请选择不同参数。");

  const metas: AxisMeta[] = [];
  request.axes.forEach((axis, index) => {
    const target = axis.target;
    const label = targetLabel(target, project.nodes);
    const integer = isIntegerTarget(target);
    if (target.kind === "node" && !nodeIds.has(target.nodeId))
      errors.push(`扫描目标“${label}”对应的节点已不存在，请重新选择。`);

    if (!(axis.step > 0) || !Number.isFinite(axis.step)) {
      errors.push(`「${label}」的步长需要是大于 0 的数字。`);
      return;
    }
    if (
      !Number.isFinite(axis.from) ||
      !Number.isFinite(axis.to)
    ) {
      errors.push(`「${label}」的区间起止值需要是有效数字。`);
      return;
    }
    if (axis.to === axis.from)
      errors.push(`「${label}」的起点和终点不能相同。`);
    if (integer && axis.step < 1)
      errors.push(`「${label}」是整数参数，步长至少为 1。`);

    let values = axisValues(axis, integer);
    let clampNote: string | undefined;
    if (values.length > MAX_AXIS_POINTS) {
      errors.push(
        `「${label}」单轴有 ${values.length} 个取值，超过单次上限 ${MAX_AXIS_POINTS} 个；请放大步长或缩小区间。`,
      );
    }
    if (target.kind === "concurrency") {
      const nodeCount = project.nodes.length;
      const clamped = values
        .map((value) => Math.max(1, Math.min(Math.round(value), Math.max(1, nodeCount))))
        .filter((value) => value >= 1);
      const deduped = [...new Set(clamped)];
      if (deduped.length !== values.length) {
        clampNote = `并发上限超过节点数（${nodeCount}）没有意义，已按 1–${nodeCount} 裁剪。`;
      }
      values = deduped;
    }
    if (errors.length === 0 && clampNote) warnings.push(clampNote);
    if (values.length < 2)
      errors.push(
        `「${label}」按当前步长只有 ${values.length} 个有效取值，无法形成扫描区间。`,
      );

    metas.push({
      index: index as 0 | 1,
      target,
      label,
      unit: targetUnit(target),
      integer,
      direction: axis.to > axis.from ? "increase" : "decrease",
      values,
      ...(clampNote ? { clampNote } : {}),
    });
  });

  if (metas.length === request.axes.length && metas.length > 0 && !errors.length) {
    const total = metas.reduce((count, meta) => count * meta.values.length, 1);
    if (total > MAX_GRID_POINTS)
      errors.push(
        `本次扫描需要推演 ${total} 个参数组合，超过单次上限 ${MAX_GRID_POINTS.toLocaleString()} 个；请缩小区间或放大步长。`,
      );
  }

  return { errors, warnings, metas };
}

/** 对一组按轴单调推进的采样找首次越线点，并在连续参数上二分细化 */
function findBracket(
  samples: SweepSample[],
  meta: AxisMeta,
  evaluateAt: (value: number) => SweepSample,
): SweepBracket | undefined {
  const crossIndex = samples.findIndex((sample) => sample.overBudget);
  if (crossIndex <= 0) return undefined;
  const inside = samples[crossIndex - 1]!;
  const outside = samples[crossIndex]!;
  const bracket: SweepBracket = { inside, outside, precision: "bracket" };
  if (!meta.integer) {
    let lo = inside.values[meta.index]!;
    let hi = outside.values[meta.index]!;
    let sample = outside;
    for (let step = 0; step < MAX_BISECTION_STEPS; step += 1) {
      if (hi - lo <= BISECTION_EPSILON) break;
      const mid = (lo + hi) / 2;
      sample = evaluateAt(mid);
      if (sample.overBudget) hi = mid;
      else lo = mid;
    }
    bracket.threshold = Math.round(hi * 10) / 10;
    bracket.precision = "exact";
  }
  return bracket;
}

/**
 * 执行扫描。通过 onChunk 在每个批次后让出主线程并汇报进度，
 * 传入 AbortSignal 可取消；取消时返回已完成点数而不是伪造结论。
 */
export async function runSweep(
  project: LatencyProject,
  request: SweepRequest,
  validation: SweepValidation,
  options: {
    signal?: AbortSignal;
    onProgress?: (evaluated: number, total: number) => void;
    chunkSize?: number;
  } = {},
): Promise<SweepOutcome | undefined> {
  if (validation.errors.length) return undefined;
  const { metas } = validation;
  const [metaA, metaB] = metas;
  if (!metaA) return undefined;
  const chunkSize = options.chunkSize ?? 16;
  const yieldToUi = () =>
    new Promise<void>((resolve) => setTimeout(resolve, 0));

  if (!metaB) {
    const axis = request.axes[0]!;
    const samples: SweepSample[] = [];
    for (let i = 0; i < metaA.values.length; i += 1) {
      samples.push(
        evaluate(project, [axis], [metaA.values[i]!], request.mode, request.budgetMs),
      );
      if (i % chunkSize === chunkSize - 1) {
        options.onProgress?.(i + 1, metaA.values.length);
        await yieldToUi();
        if (options.signal?.aborted) return undefined;
      }
    }
    options.onProgress?.(metaA.values.length, metaA.values.length);
    const anyInside = samples.some((sample) => !sample.overBudget);
    const anyOutside = samples.some((sample) => sample.overBudget);
    const bracket = anyInside
      ? findBracket(samples, metaA, (value) =>
          evaluate(project, [axis], [value], request.mode, request.budgetMs),
        )
      : undefined;
    const outcome: SweepOutcome = {
      kind: "one",
      meta: metaA,
      samples,
      bracket,
      conclusion:
        anyInside && anyOutside
          ? "crossed"
          : anyInside
            ? "always-inside"
            : "always-outside",
    };
    return outcome;
  }

  const axisA = request.axes[0]!;
  const axisB = request.axes[1]!;
  const samples: SweepSample[] = [];
  const boundaries = metaB.values.map((fixedValue): { fixedValue: number; bracket?: SweepBracket } => ({
    fixedValue,
  }));
  let alwaysInsideRows = 0;
  let firstCross: SweepSample | undefined;
  let evaluated = 0;
  const total = metaA.values.length * metaB.values.length;

  for (let row = 0; row < metaB.values.length; row += 1) {
    const fixedValue = metaB.values[row]!;
    const rowSamples: SweepSample[] = [];
    for (let col = 0; col < metaA.values.length; col += 1) {
      const sample = evaluate(
        project,
        [axisA, axisB],
        [metaA.values[col]!, fixedValue],
        request.mode,
        request.budgetMs,
      );
      rowSamples.push(sample);
      samples.push(sample);
      evaluated += 1;
      if (evaluated % chunkSize === 0) {
        options.onProgress?.(evaluated, total);
        await yieldToUi();
        if (options.signal?.aborted) return undefined;
      }
    }
    const rowBracket = findBracket(rowSamples, metaA, (value) =>
      evaluate(
        project,
        [axisA, axisB],
        [value, fixedValue],
        request.mode,
        request.budgetMs,
      ),
    );
    boundaries[row]!.bracket = rowBracket;
    if (!rowBracket) {
      if (rowSamples.every((sample) => !sample.overBudget)) alwaysInsideRows += 1;
    } else {
      const outsideValue = rowBracket.outside.values[0]!;
      // 主轴递增时，越线值越小表示越宽松；递减时相反
      const isSofter =
        !firstCross ||
        (metaA.direction === "increase"
          ? outsideValue < (firstCross.values[0] ?? Infinity)
          : outsideValue > (firstCross.values[0] ?? -Infinity));
      if (isSofter) firstCross = rowBracket.outside;
    }
  }
  options.onProgress?.(total, total);

  return {
    kind: "two",
    primary: metaA,
    secondary: metaB,
    samples,
    boundaries,
    ...(firstCross ? { firstCross } : {}),
    alwaysInsideRows,
  };
}

/** 临界点前后对比：列出关键链路变化与受影响最大的节点 */
export interface BracketImpact {
  criticalAdded: string[];
  criticalRemoved: string[];
  criticalKept: string[];
  affectedNodes: {
    nodeId: string;
    name: string;
    endDeltaMs: number;
    durationDeltaMs: number;
    onCriticalBefore: boolean;
    onCriticalAfter: boolean;
  }[];
}

export function describeBracketImpact(
  project: LatencyProject,
  bracket: SweepBracket,
): BracketImpact {
  const nameById = new Map(project.nodes.map((node) => [node.id, node.name]));
  const before = new Set(bracket.inside.criticalPath);
  const after = new Set(bracket.outside.criticalPath);
  const criticalAdded = bracket.outside.criticalPath.filter((id) => !before.has(id));
  const criticalRemoved = bracket.inside.criticalPath.filter(
    (id) => !after.has(id),
  );
  const criticalKept = bracket.inside.criticalPath.filter((id) => after.has(id));
  const nodeIds = new Set([
    ...Object.keys(bracket.inside.endMsByNode),
    ...Object.keys(bracket.outside.endMsByNode),
  ]);
  const affectedNodes = [...nodeIds]
    .map((nodeId) => ({
      nodeId,
      name: nameById.get(nodeId) ?? nodeId,
      endDeltaMs:
        (bracket.outside.endMsByNode[nodeId] ?? 0) -
        (bracket.inside.endMsByNode[nodeId] ?? 0),
      durationDeltaMs:
        (bracket.outside.durationMsByNode[nodeId] ?? 0) -
        (bracket.inside.durationMsByNode[nodeId] ?? 0),
      onCriticalBefore: before.has(nodeId),
      onCriticalAfter: after.has(nodeId),
    }))
    .filter((item) => Math.abs(item.endDeltaMs) > 0.01)
    .sort((a, b) => Math.abs(b.endDeltaMs) - Math.abs(a.endDeltaMs));
  return { criticalAdded, criticalRemoved, criticalKept, affectedNodes };
}
