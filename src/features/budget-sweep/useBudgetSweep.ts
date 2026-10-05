import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  describeBracketImpact,
  projectAtSweepPoint,
  runSweep,
  targetLabel,
  validateSweep,
  type BracketImpact,
} from "../../shared/domain/sweep";
import { saveScenario } from "../scenarios/scenarioViewModel";
import { simulateProject } from "../../shared/domain/simulation";
import type {
  LatencyProject,
  RequestNode,
  SimulationMode,
} from "../../shared/domain/types";
import type {
  AxisMeta,
  SweepAxis,
  SweepBracket,
  SweepNodeField,
  SweepOutcome,
  SweepRequest,
  SweepTarget,
} from "../../shared/domain/sweepTypes";

export interface SweepTargetOption {
  value: string;
  label: string;
  unit: string;
  integer: boolean;
}

export type SweepPhase = "idle" | "validating" | "running" | "done";

/** 把扫描目标编进 select 的 value */
export function encodeTarget(target: SweepTarget): string {
  return target.kind === "concurrency"
    ? "concurrency"
    : `node:${target.nodeId}:${target.field}`;
}

export function decodeTarget(value: string): SweepTarget | undefined {
  if (value === "concurrency") return { kind: "concurrency" };
  const match = /^node:(.+):(durationMs|jitterMs|timeoutMs|retryCount|failureRate)$/.exec(
    value,
  );
  if (!match) return undefined;
  return {
    kind: "node",
    nodeId: match[1]!,
    field: match[2] as SweepNodeField,
  };
}

const FIELD_UNITS: Record<SweepNodeField, string> = {
  durationMs: "ms",
  jitterMs: "ms",
  timeoutMs: "ms",
  retryCount: "次",
  failureRate: "%",
};

export function buildTargetOptions(
  project: LatencyProject,
): SweepTargetOption[] {
  const fields = Object.keys(FIELD_UNITS) as SweepNodeField[];
  const nodeOptions = project.nodes.flatMap((node) =>
    fields.map((field) => {
      const target: SweepTarget = { kind: "node", nodeId: node.id, field };
      return {
        value: encodeTarget(target),
        label: targetLabel(target, project.nodes),
        unit: FIELD_UNITS[field],
        integer: field === "retryCount",
      };
    }),
  );
  return [
    {
      value: "concurrency",
      label: "最大并发",
      unit: "路",
      integer: true,
    },
    ...nodeOptions,
  ];
}

export interface AxisDraft {
  targetValue: string;
  from: string;
  to: string;
  step: string;
}

export interface SweepProgress {
  evaluated: number;
  total: number;
}

export interface SavedBracketSnapshot {
  side: "inside" | "outside";
  name: string;
  saved: boolean;
}

function defaultAxisDraft(project: LatencyProject): AxisDraft {
  const firstNode = project.nodes[0];
  const current = firstNode?.durationMs ?? 400;
  return {
    targetValue: firstNode
      ? encodeTarget({ kind: "node", nodeId: firstNode.id, field: "durationMs" })
      : "concurrency",
    from: String(current),
    to: String(Math.round(current * 1.5)),
    step: "10",
  };
}

function parseNumber(text: string): number {
  const value = Number(text);
  return Number.isFinite(value) ? value : Number.NaN;
}

function toAxis(draft: AxisDraft): SweepAxis | { error: string } {
  const target = decodeTarget(draft.targetValue);
  if (!target) return { error: "请选择有效的扫描参数。" };
  const from = parseNumber(draft.from);
  const to = parseNumber(draft.to);
  const step = parseNumber(draft.step);
  if (!Number.isFinite(from)) return { error: "起点需要是数字。" };
  if (!Number.isFinite(to)) return { error: "终点需要是数字。" };
  if (!Number.isFinite(step) || step <= 0)
    return { error: "步长需要是大于 0 的数字。" };
  if (to === from) return { error: "起点和终点不能相同。" };
  return {
    id: crypto.randomUUID(),
    target,
    from: Math.min(from, to),
    to: Math.max(from, to),
    step,
  };
}

export function useBudgetSweep(
  project: LatencyProject,
  mode: SimulationMode,
  onCommitProject: (project: LatencyProject) => void,
) {
  const targetOptions = useMemo(() => buildTargetOptions(project), [project]);
  const [budgetText, setBudgetText] = useState("");
  const baselineCompletion = useMemo(
    () => simulateProject(project, mode).completionMs,
    [project, mode],
  );
  const effectiveBudget =
    parseNumber(budgetText) > 0 ? parseNumber(budgetText) : baselineCompletion;

  const [axisA, setAxisA] = useState<AxisDraft>(() =>
    defaultAxisDraft(project),
  );
  const [axisBEnabled, setAxisBEnabled] = useState(false);
  const [axisB, setAxisB] = useState<AxisDraft>(() => ({
    targetValue: "concurrency",
    from: "1",
    to: String(Math.max(2, project.nodes.length)),
    step: "1",
  }));

  const [phase, setPhase] = useState<SweepPhase>("idle");
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [progress, setProgress] = useState<SweepProgress>({
    evaluated: 0,
    total: 0,
  });
  const [outcome, setOutcome] = useState<SweepOutcome | undefined>();
  const [cancelled, setCancelled] = useState(false);
  const [savedMarks, setSavedMarks] = useState<Record<string, SavedBracketSnapshot>>(
    {},
  );
  const abortRef = useRef<AbortController | null>(null);
  const runningProjectRef = useRef<LatencyProject | null>(null);

  // 切换项目时重置扫描草稿，避免残留的旧节点 id
  useEffect(() => {
    setAxisA(defaultAxisDraft(project));
    setAxisB({
      targetValue: "concurrency",
      from: "1",
      to: String(Math.max(2, project.nodes.length)),
      step: "1",
    });
    setAxisBEnabled(false);
    setBudgetText("");
    setErrors([]);
    setWarnings([]);
    setOutcome(undefined);
    setCancelled(false);
    setSavedMarks({});
    abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  /** 当前草稿即时校验（不运行），用于界面提示与禁用按钮 */
  const draftValidation = useMemo(() => {
    const parsedA = toAxis(axisA);
    if ("error" in parsedA)
      return { errors: [parsedA.error], warnings: [], metas: [] as AxisMeta[] };
    const axes = [parsedA] as SweepAxis[];
    if (axisBEnabled) {
      const parsedB = toAxis(axisB);
      if ("error" in parsedB)
        return { errors: [parsedB.error], warnings: [], metas: [] as AxisMeta[] };
      axes.push(parsedB);
    }
    const request: SweepRequest = {
      budgetMs: effectiveBudget,
      mode,
      axes: axes as [SweepAxis] | [SweepAxis, SweepAxis],
    };
    return validateSweep(project, request);
  }, [axisA, axisB, axisBEnabled, effectiveBudget, mode, project]);

  const resetForRun = useCallback(() => {
    setErrors([]);
    setWarnings([]);
    setOutcome(undefined);
    setCancelled(false);
    setSavedMarks({});
    setProgress({ evaluated: 0, total: 0 });
  }, []);

  const start = useCallback(async () => {
    const parsedA = toAxis(axisA);
    if ("error" in parsedA) {
      setErrors([parsedA.error]);
      return;
    }
    const axes = [parsedA] as SweepAxis[];
    if (axisBEnabled) {
      const parsedB = toAxis(axisB);
      if ("error" in parsedB) {
        setErrors([parsedB.error]);
        return;
      }
      axes.push(parsedB);
    }
    const request: SweepRequest = {
      budgetMs: effectiveBudget,
      mode,
      axes: axes as [SweepAxis] | [SweepAxis, SweepAxis],
    };
    const validation = validateSweep(project, request);
    resetForRun();
    if (validation.errors.length) {
      setErrors(validation.errors);
      setWarnings(validation.warnings);
      setPhase("idle");
      return;
    }
    setWarnings(validation.warnings);
    setPhase("running");
    const controller = new AbortController();
    abortRef.current = controller;
    // 固定本次扫描所用的项目快照，扫描途中编辑不影响结论
    const runningProject = structuredClone(project);
    runningProjectRef.current = runningProject;
    const result = await runSweep(runningProject, request, validation, {
      signal: controller.signal,
      onProgress: (evaluated, total) => setProgress({ evaluated, total }),
    });
    abortRef.current = null;
    if (controller.signal.aborted || !result) {
      setCancelled(true);
      setPhase("idle");
      return;
    }
    setOutcome(result);
    setPhase("done");
  }, [
    axisA,
    axisB,
    axisBEnabled,
    effectiveBudget,
    mode,
    project,
    resetForRun,
  ]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const running = phase === "running";

  /** 保存临界点某一侧（预算内/越线）的方案快照 */
  const saveBracketSnapshot = useCallback(
    (
      key: string,
      side: "inside" | "outside",
      bracketValues: number[],
      name: string,
    ): boolean => {
      const runningProject = runningProjectRef.current;
      const parsedA = toAxis(axisA);
      if (!runningProject || "error" in parsedA) return false;
      const axes = [parsedA] as SweepAxis[];
      if (axisBEnabled) {
        const parsedB = toAxis(axisB);
        if ("error" in parsedB) return false;
        axes.push(parsedB);
      }
      const candidateProject = projectAtSweepPoint(
        runningProject,
        axes,
        bracketValues,
      );
      const result = simulateProject(candidateProject, mode);
      if (result.entries.length !== candidateProject.nodes.length) return false;
      const saved = saveScenario(candidateProject, result, name);
      // 扫描项目是启动时的克隆：把新快照并入当前项目的快照列表，
      // 避免扫描期间产生的其他快照被旧克隆覆盖
      const newSnapshot = saved.scenarios[0];
      const mergedScenarios = newSnapshot
        ? [
            newSnapshot,
            ...project.scenarios.filter(
              (scenario) => scenario.id !== newSnapshot.id,
            ),
          ]
        : project.scenarios;
      const merged: LatencyProject = {
        ...project,
        scenarios: mergedScenarios,
        updatedAt: saved.updatedAt,
      };
      onCommitProject(merged);
      setSavedMarks((current) => ({
        ...current,
        [key]: { side, name, saved: true },
      }));
      return true;
    },
    [axisA, axisB, axisBEnabled, mode, onCommitProject, project],
  );

  const impactFor = useCallback(
    (bracket: SweepBracket | undefined): BracketImpact | undefined =>
      runningProjectRef.current && bracket
        ? describeBracketImpact(runningProjectRef.current, bracket)
        : undefined,
    [],
  );

  return {
    targetOptions,
    budgetText,
    setBudgetText,
    effectiveBudget,
    baselineCompletion,
    axisA,
    setAxisA,
    axisB,
    setAxisB,
    axisBEnabled,
    setAxisBEnabled,
    phase,
    running,
    errors,
    warnings,
    draftErrors: draftValidation.errors,
    progress,
    outcome,
    cancelled,
    savedMarks,
    start,
    cancel,
    saveBracketSnapshot,
    impactFor,
  };
}

export type BudgetSweepController = ReturnType<typeof useBudgetSweep>;

export function nodeNameById(
  project: LatencyProject,
): (id: string) => string {
  const map = new Map<string, RequestNode>(
    project.nodes.map((node) => [node.id, node]),
  );
  return (id: string) => map.get(id)?.name ?? id;
}
