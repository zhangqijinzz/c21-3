import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Crosshair,
  LoaderCircle,
  Play,
  Save,
  Square,
  Target,
  XCircle,
} from "lucide-react";
import type { LatencyProject, SimulationMode } from "../../shared/domain/types";
import {
  formatNumber,
  getScanParameterDefinitions,
  MAX_SCAN_POINTS,
  type BudgetScanResult,
  type ScanAxisRequest,
  type ScanParameterKey,
} from "../../shared/domain/scan";

interface Props {
  project: LatencyProject;
  mode: SimulationMode;
  currentCompletionMs: number;
  result: BudgetScanResult | null;
  progress: { completed: number; total: number };
  isScanning: boolean;
  onRun: (targetMs: number, axes: ScanAxisRequest[]) => Promise<void>;
  onCancel: () => void;
  onSaveSnapshots: () => boolean;
}

interface AxisForm {
  selection: string;
  start: string;
  end: string;
  step: string;
}

const axisParameterOptions = (
  project: LatencyProject,
): {
  value: string;
  label: string;
  nodeId?: string;
  key: ScanParameterKey;
}[] =>
  getScanParameterDefinitions(project).map(({ node, parameter }) => ({
    value: `${node?.id ?? "project"}:${parameter.key}`,
    label: node ? `${node.name} · ${parameter.label}` : parameter.label,
    ...(node ? { nodeId: node.id } : {}),
    key: parameter.key,
  }));

const parseAxis = (form: AxisForm): ScanAxisRequest | null => {
  const [nodeId, key] = form.selection.split(":") as [string, ScanParameterKey];
  const start = Number(form.start);
  const end = Number(form.end);
  const step = Number(form.step);
  if (!key) return null;
  return {
    parameterKey: key,
    ...(nodeId && nodeId !== "project" ? { nodeId } : {}),
    start,
    end,
    step,
  };
};

function durationLabel(value: number): string {
  return value < 1000
    ? `${Math.round(value)} ms`
    : `${(value / 1000).toFixed(2)} s`;
}

function pathNames(ids: string[], project: LatencyProject): string[] {
  return ids
    .map((id) => project.nodes.find((node) => node.id === id)?.name ?? id)
    .filter(Boolean);
}

function axisFormForSelection(
  project: LatencyProject,
  selection: string,
): AxisForm {
  const [nodeId, key] = selection.split(":") as [string, ScanParameterKey];
  if (key === "concurrency" || nodeId === "project")
    return { selection, start: "8", end: "1", step: "1" };
  const node = project.nodes.find((item) => item.id === nodeId);
  if (!node) return { selection, start: "0", end: "100", step: "10" };
  if (key === "durationMs")
    return {
      selection,
      start: String(node.durationMs),
      end: String(node.durationMs + 1000),
      step: "50",
    };
  if (key === "jitterMs")
    return {
      selection,
      start: String(node.jitterMs),
      end: String(Math.min(300_000, node.jitterMs + 500)),
      step: "25",
    };
  if (key === "timeoutMs")
    return {
      selection,
      start: String(node.timeoutMs),
      end: String(Math.min(600_000, node.timeoutMs + 1000)),
      step: "50",
    };
  if (key === "retryCount")
    return {
      selection,
      start: String(node.retryCount),
      end: "8",
      step: "1",
    };
  return {
    selection,
    start: String(node.failureRate),
    end: "100",
    step: "5",
  };
}

function defaultAxisForm(project: LatencyProject, index = 0): AxisForm {
  const node = project.nodes[index] ?? project.nodes[0];
  return axisFormForSelection(
    project,
    node ? `${node.id}:durationMs` : "project:concurrency",
  );
}

export default function ScanPanel({
  project,
  mode,
  currentCompletionMs,
  result,
  progress,
  isScanning,
  onRun,
  onCancel,
  onSaveSnapshots,
}: Props) {
  const options = useMemo(() => axisParameterOptions(project), [project]);
  const [target, setTarget] = useState(
    String(Math.max(1000, Math.ceil(currentCompletionMs / 100) * 100 + 300)),
  );
  const [useSecondAxis, setUseSecondAxis] = useState(false);
  const [axisForms, setAxisForms] = useState<[AxisForm, AxisForm]>(() => [
    defaultAxisForm(project, 0),
    defaultAxisForm(project, 1),
  ]);

  const updateAxis = (index: 0 | 1, patch: Partial<AxisForm>) => {
    setAxisForms(
      (current) =>
        current.map((axis, axisIndex) => {
          if (axisIndex !== index) return axis;
          if (patch.selection && patch.selection !== axis.selection)
            return axisFormForSelection(project, patch.selection);
          return { ...axis, ...patch };
        }) as [AxisForm, AxisForm],
    );
  };

  const run = async () => {
    const axes = axisForms
      .slice(0, useSecondAxis ? 2 : 1)
      .map(parseAxis)
      .filter((axis): axis is ScanAxisRequest => Boolean(axis));
    await onRun(Number(target), axes);
  };

  const completed = result?.status === "completed" ? result : null;
  const progressPercent = progress.total
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;

  return (
    <section className="module-page scan-page">
      <div className="module-heading">
        <div>
          <span className="eyebrow">04 / BUDGET SCAN</span>
          <h1>预算越线扫描</h1>
          <p>
            选定整页目标完成时间与一到两个参数，在区间内完整推演，找出预算刚好越线的临界值。
          </p>
        </div>
        {isScanning ? (
          <button className="button button-danger-outline" onClick={onCancel}>
            <Square size={14} fill="currentColor" /> 停止扫描
          </button>
        ) : (
          <button className="button button-primary" onClick={run}>
            <Play size={15} fill="currentColor" /> 开始扫描
          </button>
        )}
      </div>

      <div className="scan-config-card">
        <div className="scan-target-field">
          <span className="toolbar-label">
            <Target size={12} /> 目标完成时间
          </span>
          <div className="scan-target-input">
            <input
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              inputMode="numeric"
              disabled={isScanning}
            />
            <small>ms</small>
          </div>
          <p>
            当前{mode === "low" ? "乐观" : mode === "high" ? "保守" : "预期"}
            情境完成时间：
            <b>{durationLabel(currentCompletionMs)}</b>
          </p>
        </div>
        <div className="scan-axis-list">
          {axisForms.slice(0, useSecondAxis ? 2 : 1).map((form, index) => (
            <ScanAxisForm
              key={index}
              index={index}
              form={form}
              options={options}
              disabled={isScanning}
              onChange={(patch) => updateAxis(index as 0 | 1, patch)}
            />
          ))}
        </div>
        <button
          className="scan-toggle-axis"
          onClick={() => setUseSecondAxis((value) => !value)}
          disabled={isScanning}
        >
          {useSecondAxis ? "− 移除第二参数" : "+ 增加第二参数，做二维组合扫描"}
        </button>
        <div className="scan-limit-note">
          区间必须沿“更容易超线”的方向填写；最多完整推演{" "}
          {MAX_SCAN_POINTS.toLocaleString("zh-CN")} 个参数组合。
        </div>
      </div>

      {isScanning && (
        <div className="scan-progress-card">
          <LoaderCircle size={18} className="spin-icon" />
          <div>
            <strong>正在完整推演，界面仍可操作</strong>
            <p>
              已完成 {progress.completed.toLocaleString("zh-CN")} /{" "}
              {progress.total.toLocaleString("zh-CN")} 个组合（{progressPercent}
              %）。停止后不会只根据部分结果给出临界值。
            </p>
            <div className="scan-progress-track">
              <i style={{ width: `${progressPercent}%` }} />
            </div>
          </div>
        </div>
      )}

      {result?.status === "invalid" && (
        <div className="scan-feedback scan-error">
          <AlertTriangle size={18} />
          <div>
            <strong>无法开始扫描</strong>
            <ul>
              {result.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {result?.status === "cancelled" && (
        <div className="scan-feedback scan-cancelled">
          <XCircle size={18} />
          <div>
            <strong>扫描已取消</strong>
            <p>
              已完成 {result.completedPoints.toLocaleString("zh-CN")} /{" "}
              {result.totalPoints.toLocaleString("zh-CN")}{" "}
              个组合，未生成临界值结论。
            </p>
          </div>
        </div>
      )}

      {completed && (
        <ScanResultView
          project={project}
          result={completed}
          onSaveSnapshots={onSaveSnapshots}
        />
      )}
    </section>
  );
}

interface AxisFormProps {
  index: number;
  form: AxisForm;
  options: { value: string; label: string }[];
  disabled: boolean;
  onChange: (patch: Partial<AxisForm>) => void;
}

function ScanAxisForm({
  index,
  form,
  options,
  disabled,
  onChange,
}: AxisFormProps) {
  return (
    <article className="scan-axis-card">
      <header>
        <span>扫描参数 {index + 1}</span>
      </header>
      <select
        value={form.selection}
        onChange={(event) => onChange({ selection: event.target.value })}
        disabled={disabled}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <div className="scan-range-grid">
        <label>
          <span>起点</span>
          <input
            value={form.start}
            onChange={(event) => onChange({ start: event.target.value })}
            inputMode="numeric"
            disabled={disabled}
          />
        </label>
        <label>
          <span>终点</span>
          <input
            value={form.end}
            onChange={(event) => onChange({ end: event.target.value })}
            inputMode="numeric"
            disabled={disabled}
          />
        </label>
        <label>
          <span>步长</span>
          <input
            value={form.step}
            onChange={(event) => onChange({ step: event.target.value })}
            inputMode="numeric"
            disabled={disabled}
          />
        </label>
      </div>
    </article>
  );
}

function ScanResultView({
  project,
  result,
  onSaveSnapshots,
}: {
  project: LatencyProject;
  result: Extract<BudgetScanResult, { status: "completed" }>;
  onSaveSnapshots: () => boolean;
}) {
  if (!result.boundary || result.outcome !== "crossed") {
    const allBreached = result.outcome === "all-breached";
    return (
      <div
        className={`scan-feedback ${allBreached ? "scan-warning" : "scan-ok"}`}
      >
        {allBreached ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
        <div>
          <strong>
            {allBreached ? "区间起点已经超线" : "整个区间均未超线"}
          </strong>
          <p>
            已完整推演 {result.totalPoints.toLocaleString("zh-CN")} 个组合。
            {allBreached
              ? "请把起点改到更安全的一侧，或先降低当前链路耗时。"
              : "请扩大区间或选择更敏感的参数后再次扫描。"}
          </p>
          <div className="scan-endpoint-grid">
            <EndpointCard
              title="区间低风险端"
              point={result.lowRiskPoint}
              project={project}
            />
            <EndpointCard
              title="区间高风险端"
              point={result.highRiskPoint}
              project={project}
            />
          </div>
        </div>
      </div>
    );
  }

  const boundary = result.boundary;
  const primaryAxis = result.axes[boundary.primaryAxisIndex]!;
  const beforeNames = pathNames(boundary.criticalPathBefore, project);
  const afterNames = pathNames(boundary.criticalPathAfter, project);
  return (
    <div className="scan-result-layout">
      <article className="scan-threshold-card">
        <div className="scan-threshold-head">
          <Crosshair size={19} />
          <div>
            <span>临界越线值</span>
            <strong>{boundary.thresholdLabel}</strong>
          </div>
          <button className="button button-lime" onClick={onSaveSnapshots}>
            <Save size={14} /> 保存前后快照
          </button>
        </div>
        <p>
          在 {primaryAxis.displayName} 的相邻采样点之间，完成预算从{" "}
          <b>{durationLabel(boundary.safePoint.result.completionMs)}</b> 变为{" "}
          <b>{durationLabel(boundary.breachPoint.result.completionMs)}</b>
          ，目标为 {durationLabel(result.targetMs)}。共发现{" "}
          {result.boundarySegments.length} 段离散临界边。
        </p>
      </article>

      {result.boundarySegments.length > 1 && (
        <article className="scan-boundary-list-card">
          <div>
            <strong>二维扫描中的全部临界段</strong>
            <span>{result.boundarySegments.length} 段</span>
          </div>
          <ol>
            {result.boundarySegments.slice(0, 8).map((segment, index) => (
              <li key={`${segment.thresholdLabel}-${index}`}>
                <b>{segment.thresholdLabel}</b>
                <span>
                  {durationLabel(segment.safePoint.result.completionMs)} →{" "}
                  {durationLabel(segment.breachPoint.result.completionMs)}
                </span>
              </li>
            ))}
          </ol>
          {result.boundarySegments.length > 8 && (
            <small>
              仅展示前 8 段；保存的方案使用越线幅度最小的代表性临界段。
            </small>
          )}
        </article>
      )}

      <div className="scan-point-grid">
        <PointCard
          title="临界点前（仍在线内）"
          tone="safe"
          point={boundary.safePoint}
          project={project}
        />
        <PointCard
          title="临界点后（首次越线）"
          tone="breached"
          point={boundary.breachPoint}
          project={project}
        />
      </div>

      <div className="scan-path-grid">
        <article className="scan-path-card">
          <span>越线前关键链路</span>
          <ol>
            {beforeNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ol>
        </article>
        <article className="scan-path-card">
          <span>越线后关键链路</span>
          <ol>
            {afterNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ol>
        </article>
      </div>

      <article className="scan-impact-card">
        <div className="scan-impact-head">
          <strong>最受影响节点</strong>
          <span>按结束时间变化排序</span>
        </div>
        <div className="scan-impact-table">
          <div className="scan-impact-row scan-impact-header">
            <span>节点</span>
            <span>结束时间变化</span>
            <span>执行耗时变化</span>
            <span>等待变化</span>
            <span>关键链路</span>
          </div>
          {boundary.affectedNodes.map((node) => (
            <div className="scan-impact-row" key={node.nodeId}>
              <span>{node.nodeName}</span>
              <b className={node.deltaEndMs > 0 ? "delta-bad" : ""}>
                +{formatNumber(node.deltaEndMs)} ms
              </b>
              <span>+{formatNumber(node.deltaDurationMs)} ms</span>
              <span>+{formatNumber(Math.max(0, node.deltaWaitMs))} ms</span>
              <span>
                {node.criticalBefore && !node.criticalAfter
                  ? "离开关键链路"
                  : !node.criticalBefore && node.criticalAfter
                    ? "进入关键链路"
                    : node.criticalAfter
                      ? "持续关键"
                      : "非关键"}
              </span>
            </div>
          ))}
        </div>
      </article>
    </div>
  );
}

function EndpointCard({
  title,
  point,
  project,
}: {
  title: string;
  point: Extract<BudgetScanResult, { status: "completed" }>["lowRiskPoint"];
  project: LatencyProject;
}) {
  return (
    <div>
      <span>{title}</span>
      <strong className={point.breached ? "delta-bad" : "delta-good"}>
        {durationLabel(point.result.completionMs)}
      </strong>
      <small>{pathNames(point.result.criticalPath, project).join(" → ")}</small>
    </div>
  );
}

function PointCard({
  title,
  tone,
  point,
  project,
}: {
  title: string;
  tone: "safe" | "breached";
  point: Extract<BudgetScanResult, { status: "completed" }>["lowRiskPoint"];
  project: LatencyProject;
}) {
  return (
    <article className={`scan-point-card ${tone}`}>
      <span>{title}</span>
      <strong>{durationLabel(point.result.completionMs)}</strong>
      <small>{pathNames(point.result.criticalPath, project).join(" → ")}</small>
      <div className="scan-parameter-values">
        {point.values.map((value) => (
          <em key={`${value.nodeId ?? "project"}:${value.parameterKey}`}>
            {value.label}：{formatNumber(value.value)} {value.unit}
          </em>
        ))}
      </div>
    </article>
  );
}
