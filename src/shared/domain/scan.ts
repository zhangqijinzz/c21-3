import { analyzeGraph } from "./graph";
import { simulateProject } from "./simulation";
import type { LatencyProject, SimulationMode, SimulationResult } from "./types";

export const MAX_SCAN_POINTS = 1000;
const CHUNK_SIZE = 20;

export type ScanParameterKey =
  | "concurrency"
  | "durationMs"
  | "jitterMs"
  | "timeoutMs"
  | "retryCount"
  | "failureRate";

export interface ScanAxisRequest {
  parameterKey: ScanParameterKey;
  nodeId?: string;
  start: number;
  end: number;
  step: number;
}

export interface ScanRequest {
  project: LatencyProject;
  mode: SimulationMode;
  targetMs: number;
  axes: [ScanAxisRequest] | [ScanAxisRequest, ScanAxisRequest];
}

export interface ScanParameterDefinition {
  key: ScanParameterKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  integer: boolean;
  riskDirection: 1 | -1;
}

export interface ResolvedScanAxis extends ScanParameterDefinition {
  axisIndex: number;
  nodeId?: string;
  nodeName?: string;
  displayName: string;
  start: number;
  end: number;
  step: number;
  points: number;
}

export interface ScanPointValue {
  axisIndex: number;
  parameterKey: ScanParameterKey;
  nodeId?: string;
  label: string;
  unit: string;
  value: number;
}

export interface ScannedPoint {
  coordinates: number[];
  values: ScanPointValue[];
  result: SimulationResult;
  breached: boolean;
}

export interface ScanAffectedNode {
  nodeId: string;
  nodeName: string;
  deltaEndMs: number;
  deltaDurationMs: number;
  deltaWaitMs: number;
  criticalBefore: boolean;
  criticalAfter: boolean;
}

export interface ScanBoundaryPair {
  safePoint: ScannedPoint;
  breachPoint: ScannedPoint;
  primaryAxisIndex: number;
  estimatedValue: number;
  thresholdLabel: string;
  criticalPathBefore: string[];
  criticalPathAfter: string[];
  affectedNodes: ScanAffectedNode[];
}

export interface ScanBoundarySegment {
  safeCoordinates: number[];
  breachCoordinates: number[];
  changingAxisIndex: number;
  safePoint: ScannedPoint;
  breachPoint: ScannedPoint;
  estimatedValue: number;
  thresholdLabel: string;
}

export type ScanOutcome = "crossed" | "all-safe" | "all-breached";

interface CompletedScan {
  status: "completed";
  projectId: string;
  mode: SimulationMode;
  targetMs: number;
  axes: ResolvedScanAxis[];
  totalPoints: number;
  outcome: ScanOutcome;
  boundary: ScanBoundaryPair | null;
  boundarySegments: ScanBoundarySegment[];
  lowRiskPoint: ScannedPoint;
  highRiskPoint: ScannedPoint;
}

interface InvalidScan {
  status: "invalid";
  errors: string[];
  totalPoints?: number;
}

interface CancelledScan {
  status: "cancelled";
  completedPoints: number;
  totalPoints: number;
}

export type BudgetScanResult = CompletedScan | InvalidScan | CancelledScan;

export interface ScanRunHandlers {
  onProgress?: (completed: number, total: number) => void;
  signal?: { aborted: boolean };
}

const parameterDefinitions: Record<
  ScanParameterKey,
  Omit<ScanParameterDefinition, "key">
> = {
  concurrency: {
    label: "最大并发",
    unit: "路",
    min: 1,
    max: 16,
    integer: true,
    riskDirection: -1,
  },
  durationMs: {
    label: "基础耗时",
    unit: "ms",
    min: 0,
    max: 600_000,
    integer: false,
    riskDirection: 1,
  },
  jitterMs: {
    label: "波动范围",
    unit: "ms",
    min: 0,
    max: 300_000,
    integer: false,
    riskDirection: 1,
  },
  timeoutMs: {
    label: "超时时间",
    unit: "ms",
    min: 0,
    max: 600_000,
    integer: false,
    riskDirection: 1,
  },
  retryCount: {
    label: "重试次数",
    unit: "次",
    min: 0,
    max: 8,
    integer: true,
    riskDirection: 1,
  },
  failureRate: {
    label: "失败率",
    unit: "%",
    min: 0,
    max: 100,
    integer: false,
    riskDirection: 1,
  },
};

export function getScanParameterDefinitions(project: LatencyProject): {
  node?: { id: string; name: string };
  parameter: ScanParameterDefinition;
}[] {
  const concurrency = {
    parameter: {
      key: "concurrency" as const,
      ...parameterDefinitions.concurrency,
    },
  };
  const nodeParameters = project.nodes.flatMap((node) =>
    (
      [
        "durationMs",
        "jitterMs",
        "timeoutMs",
        "retryCount",
        "failureRate",
      ] as const
    ).map((key) => ({
      node: { id: node.id, name: node.name },
      parameter: { key, ...parameterDefinitions[key] },
    })),
  );
  return [concurrency, ...nodeParameters];
}

function isFiniteNumber(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function axisSignature(axis: ScanAxisRequest): string {
  return `${axis.nodeId ?? "project"}:${axis.parameterKey}`;
}

export function validateScanRequest(request: ScanRequest): {
  errors: string[];
  axes: ResolvedScanAxis[];
  totalPoints: number;
} {
  const errors: string[] = [];
  const analysis = analyzeGraph(request.project);
  errors.push(...analysis.validation.errors);
  if (!request.project.nodes.length)
    errors.push("当前链路还没有请求节点，无法扫描预算边界。");
  if (!isFiniteNumber(request.targetMs) || request.targetMs <= 0)
    errors.push("目标完成时间需要是大于 0 的数字。");
  if (request.axes.length < 1 || request.axes.length > 2)
    errors.push("每次扫描需要选择一个或两个参数。");

  const signatures = request.axes.map(axisSignature);
  if (new Set(signatures).size !== signatures.length)
    errors.push("两个扫描参数不能相同，请选择不同的节点或参数。");

  const resolvedAxes = request.axes.map(
    (axis, axisIndex): ResolvedScanAxis | null => {
      const definition = parameterDefinitions[axis.parameterKey];
      if (!definition) {
        errors.push("存在不支持的扫描参数。");
        return null;
      }
      let nodeName: string | undefined;
      if (axis.parameterKey === "concurrency") {
        if (axis.nodeId) errors.push("最大并发是项目级参数，不需要选择节点。");
      } else {
        const node = request.project.nodes.find(
          (item) => item.id === axis.nodeId,
        );
        if (!node) {
          errors.push(`扫描参数「${definition.label}」没有选择有效节点。`);
          return null;
        }
        nodeName = node.name;
      }

      for (const [fieldName, value] of [
        ["起始值", axis.start],
        ["结束值", axis.end],
        ["步长", axis.step],
      ] as const) {
        if (!isFiniteNumber(value)) {
          errors.push(
            `${nodeName ? `${nodeName} · ` : ""}${definition.label}的${fieldName}需要是数字。`,
          );
          continue;
        }
        if (definition.integer && !Number.isInteger(value))
          errors.push(
            `${nodeName ? `${nodeName} · ` : ""}${definition.label}的${fieldName}必须是整数。`,
          );
        if (
          isFiniteNumber(value) &&
          fieldName !== "步长" &&
          (value < definition.min || value > definition.max)
        )
          errors.push(
            `${nodeName ? `${nodeName} · ` : ""}${definition.label}的${fieldName}需在 ${formatNumber(definition.min)}–${formatNumber(definition.max)} ${definition.unit} 之间。`,
          );
        if (fieldName === "步长" && value <= 0)
          errors.push(
            `${nodeName ? `${nodeName} · ` : ""}${definition.label}的步长必须大于 0。`,
          );
        if (
          fieldName === "步长" &&
          isFiniteNumber(value) &&
          isFiniteNumber(axis.start) &&
          isFiniteNumber(axis.end) &&
          axis.start !== axis.end &&
          value > Math.abs(axis.end - axis.start)
        )
          errors.push(
            `${nodeName ? `${nodeName} · ` : ""}${definition.label}的步长不能大于区间宽度，否则只能覆盖起点。`,
          );
      }

      const displayName = nodeName
        ? `${nodeName} · ${definition.label}`
        : definition.label;
      if (!isFiniteNumber(axis.start) || !isFiniteNumber(axis.end)) return null;
      const movesTowardRisk =
        Math.sign(axis.end - axis.start) === definition.riskDirection;
      if (axis.start !== axis.end && !movesTowardRisk) {
        errors.push(
          definition.riskDirection === 1
            ? `区间方向写反：${displayName}越高越可能超线，请从小值填到大值（例如 ${formatNumber(axis.end)} → ${formatNumber(axis.start)} ${definition.unit}）。`
            : `区间方向写反：${displayName}越低越可能超线，请从大值填到小值（例如 ${formatNumber(axis.end)} → ${formatNumber(axis.start)} ${definition.unit}）。`,
        );
      }

      if (
        !isFiniteNumber(axis.step) ||
        axis.step <= 0 ||
        !isFiniteNumber(axis.start) ||
        !isFiniteNumber(axis.end)
      )
        return null;
      const distance = Math.abs(axis.end - axis.start);
      const points = Math.floor(distance / axis.step) + 1;
      if (points < 1)
        errors.push(`${displayName}的区间至少需要包含一个采样点。`);
      return {
        ...definition,
        key: axis.parameterKey,
        axisIndex,
        nodeId: axis.nodeId,
        nodeName,
        displayName,
        start: axis.start,
        end: axis.end,
        step: axis.step,
        points,
      };
    },
  );

  const axes = resolvedAxes.filter((axis): axis is ResolvedScanAxis =>
    Boolean(axis),
  );
  let totalPoints = axes.reduce((total, axis) => total * axis.points, 1);
  if (axes.some((axis) => axis.points > MAX_SCAN_POINTS))
    errors.push(
      `该扫描轴会产生 ${Math.max(...axes.map((axis) => axis.points)).toLocaleString("zh-CN")} 个采样点，不能超过 ${MAX_SCAN_POINTS.toLocaleString("zh-CN")} 个；请扩大步长或缩小区间。`,
    );
  if (axes.length === 2 && totalPoints > MAX_SCAN_POINTS)
    errors.push(
      `本次二维扫描需要推演 ${totalPoints.toLocaleString("zh-CN")} 个组合，超过 ${MAX_SCAN_POINTS.toLocaleString("zh-CN")} 个上限；请扩大步长或缩小区间。`,
    );
  if (!Number.isFinite(totalPoints)) totalPoints = 0;
  return { errors, axes, totalPoints };
}

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1000) / 1000);
}

function valueAt(axis: ResolvedScanAxis, index: number): number {
  const raw =
    axis.riskDirection === 1
      ? axis.start + axis.step * index
      : axis.start - axis.step * index;
  const value = axis.integer ? Math.round(raw) : Math.round(raw * 1000) / 1000;
  return Math.min(axis.max, Math.max(axis.min, value));
}

export function buildProjectAtPoint(
  project: LatencyProject,
  point: ScannedPoint,
): LatencyProject {
  const next: LatencyProject = structuredClone(project);
  for (const value of point.values) {
    if (value.parameterKey === "concurrency") {
      next.concurrencyLimit = Math.round(value.value);
      continue;
    }
    const node = next.nodes.find((item) => item.id === value.nodeId);
    if (node) {
      node[value.parameterKey as Exclude<ScanParameterKey, "concurrency">] =
        value.value as never;
    }
  }
  return next;
}

function makePoint(
  project: LatencyProject,
  axes: ResolvedScanAxis[],
  coordinates: number[],
  mode: SimulationMode,
): ScannedPoint {
  const values = axes.map((axis, index) => ({
    axisIndex: index,
    parameterKey: axis.key,
    ...(axis.nodeId ? { nodeId: axis.nodeId } : {}),
    label: axis.displayName,
    unit: axis.unit,
    value: valueAt(axis, coordinates[index] ?? 0),
  }));
  const point: ScannedPoint = {
    coordinates,
    values,
    result: {
      mode,
      completionMs: 0,
      criticalPath: [],
      entries: [],
      warnings: [],
    },
    breached: false,
  };
  const simulated = simulateProject(buildProjectAtPoint(project, point), mode);
  point.result = simulated;
  return point;
}

function delay(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function compareAffectedNodes(
  safePoint: ScannedPoint,
  breachPoint: ScannedPoint,
  project: LatencyProject,
): ScanAffectedNode[] {
  const safeEntries = new Map(
    safePoint.result.entries.map((entry) => [entry.nodeId, entry]),
  );
  const safeCritical = new Set(safePoint.result.criticalPath);
  const breachCritical = new Set(breachPoint.result.criticalPath);
  return breachPoint.result.entries
    .map((breachEntry) => {
      const safeEntry = safeEntries.get(breachEntry.nodeId);
      const node = project.nodes.find((item) => item.id === breachEntry.nodeId);
      return {
        nodeId: breachEntry.nodeId,
        nodeName: node?.name ?? breachEntry.nodeId,
        deltaEndMs: breachEntry.endMs - (safeEntry?.endMs ?? 0),
        deltaDurationMs:
          breachEntry.modeledDurationMs - (safeEntry?.modeledDurationMs ?? 0),
        deltaWaitMs: breachEntry.waitMs - (safeEntry?.waitMs ?? 0),
        criticalBefore: safeCritical.has(breachEntry.nodeId),
        criticalAfter: breachCritical.has(breachEntry.nodeId),
      };
    })
    .sort((left, right) => right.deltaEndMs - left.deltaEndMs)
    .slice(0, 5);
}

function compareCoordinates(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export async function runBudgetScan(
  request: ScanRequest,
  handlers: ScanRunHandlers = {},
): Promise<BudgetScanResult> {
  const { errors, axes, totalPoints } = validateScanRequest(request);
  if (errors.length) return { status: "invalid", errors, totalPoints };

  const pointCounts = axes.map((axis) => axis.points);
  const samples: ScannedPoint[] = [];
  let completed = 0;
  const target = request.targetMs;
  const coordinatesFor = (index: number): number[] => {
    let rest = index;
    const coordinates: number[] = [];
    for (let axisIndex = 0; axisIndex < axes.length; axisIndex += 1) {
      const stride = pointCounts
        .slice(axisIndex + 1)
        .reduce((a, b) => a * b, 1);
      const coordinate = Math.floor(rest / stride);
      coordinates.push(coordinate);
      rest %= stride;
    }
    return coordinates;
  };

  handlers.onProgress?.(0, totalPoints);
  for (let index = 0; index < totalPoints; index += 1) {
    if (handlers.signal?.aborted)
      return { status: "cancelled", completedPoints: completed, totalPoints };
    const point = makePoint(
      request.project,
      axes,
      coordinatesFor(index),
      request.mode,
    );
    point.breached = point.result.completionMs > target;
    samples.push(point);
    completed += 1;
    if (completed % CHUNK_SIZE === 0 || completed === totalPoints) {
      handlers.onProgress?.(completed, totalPoints);
      await delay();
      if (handlers.signal?.aborted)
        return { status: "cancelled", completedPoints: completed, totalPoints };
    }
  }

  const lowRiskPoint = samples[0]!;
  const highRiskPoint = samples[samples.length - 1]!;
  const getSample = (coordinates: number[]) => {
    const index = coordinates.reduce(
      (total, coordinate, axisIndex) =>
        total +
        coordinate *
          pointCounts.slice(axisIndex + 1).reduce((a, b) => a * b, 1),
      0,
    );
    return samples[index]!;
  };
  const rawBoundarySegments: {
    safeCoordinates: number[];
    breachCoordinates: number[];
    changingAxisIndex: number;
  }[] = [];
  for (let x = 0; x < pointCounts[0]! - 1; x += 1) {
    const yLength = pointCounts[1] ?? 1;
    for (let y = 0; y < yLength; y += 1) {
      const safeCoordinates = [x, ...(axes.length > 1 ? [y] : [])];
      const breachCoordinates = [x + 1, ...(axes.length > 1 ? [y] : [])];
      const safe = getSample(safeCoordinates);
      const breach = getSample(breachCoordinates);
      if (!safe.breached && breach.breached)
        rawBoundarySegments.push({
          safeCoordinates,
          breachCoordinates,
          changingAxisIndex: 0,
        });
    }
  }
  if (axes.length > 1) {
    for (let x = 0; x < pointCounts[0]!; x += 1) {
      for (let y = 0; y < pointCounts[1]! - 1; y += 1) {
        const safe = getSample([x, y]);
        const breach = getSample([x, y + 1]);
        if (!safe.breached && breach.breached)
          rawBoundarySegments.push({
            safeCoordinates: [x, y],
            breachCoordinates: [x, y + 1],
            changingAxisIndex: 1,
          });
      }
    }
  }

  let outcome: ScanOutcome = "crossed";
  if (!rawBoundarySegments.length)
    outcome = lowRiskPoint.breached ? "all-breached" : "all-safe";

  const boundarySegments: ScanBoundarySegment[] = rawBoundarySegments.map(
    (segment) => {
      const safePoint = getSample(segment.safeCoordinates);
      const breachPoint = getSample(segment.breachCoordinates);
      const pair = completeBoundaryPair(
        request.project,
        safePoint,
        breachPoint,
        segment.changingAxisIndex,
        axes,
        request.targetMs,
      );
      return {
        ...segment,
        safePoint,
        breachPoint,
        estimatedValue: pair.estimatedValue,
        thresholdLabel: pair.thresholdLabel,
      };
    },
  );

  let boundary: ScanBoundaryPair | null = null;
  if (boundarySegments.length) {
    const representative = [...boundarySegments].sort((left, right) => {
      const leftBreach = left.breachPoint.result.completionMs;
      const rightBreach = right.breachPoint.result.completionMs;
      const excessDifference =
        leftBreach - request.targetMs - (rightBreach - request.targetMs);
      if (excessDifference !== 0) return excessDifference;
      return compareCoordinates(
        left.breachCoordinates,
        right.breachCoordinates,
      );
    })[0]!;
    boundary = completeBoundaryPair(
      request.project,
      representative.safePoint,
      representative.breachPoint,
      representative.changingAxisIndex,
      axes,
      request.targetMs,
    );
  }

  return {
    status: "completed",
    projectId: request.project.id,
    mode: request.mode,
    targetMs: request.targetMs,
    axes,
    totalPoints,
    outcome,
    boundary,
    boundarySegments,
    lowRiskPoint,
    highRiskPoint,
  };
}

function completeBoundaryPair(
  project: LatencyProject,
  safePoint: ScannedPoint,
  breachPoint: ScannedPoint,
  primaryAxisIndex: number,
  axes: ResolvedScanAxis[],
  targetMs: number,
): ScanBoundaryPair {
  const axis = axes[primaryAxisIndex]!;
  const safeValue = safePoint.values[primaryAxisIndex]?.value ?? 0;
  const breachValue = breachPoint.values[primaryAxisIndex]?.value ?? 0;
  const safeCompletion = safePoint.result.completionMs;
  const breachCompletion = breachPoint.result.completionMs;
  const denominator = breachCompletion - safeCompletion;
  const ratio =
    denominator <= 0
      ? 0
      : Math.min(1, Math.max(0, (targetMs - safeCompletion) / denominator));
  const estimatedValue = safeValue + (breachValue - safeValue) * ratio;
  const fixedValues = axes
    .filter((_, index) => index !== primaryAxisIndex)
    .map((fixedAxis) => {
      const value = breachPoint.values[fixedAxis.axisIndex]?.value ?? 0;
      return `${fixedAxis.displayName} ${formatNumber(value)} ${fixedAxis.unit}`;
    });
  const valueLabel = axis.integer
    ? `${formatNumber(safeValue)}–${formatNumber(breachValue)} ${axis.unit}（线性估计约 ${formatNumber(estimatedValue)}）`
    : `${formatNumber(estimatedValue)} ${axis.unit}`;
  const thresholdLabel = `${axis.displayName}：${valueLabel}${
    fixedValues.length ? `（${fixedValues.join("，")}）` : ""
  }`;
  return {
    safePoint,
    breachPoint,
    primaryAxisIndex,
    estimatedValue,
    thresholdLabel,
    criticalPathBefore: safePoint.result.criticalPath,
    criticalPathAfter: breachPoint.result.criticalPath,
    affectedNodes: compareAffectedNodes(safePoint, breachPoint, project),
  };
}
