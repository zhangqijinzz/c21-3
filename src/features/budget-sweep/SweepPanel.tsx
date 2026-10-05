import { useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Crosshair,
  Save,
  ScanLine,
  ShieldAlert,
  Square,
} from "lucide-react";
import { MAX_GRID_POINTS } from "../../shared/domain/sweep";
import type {
  LatencyProject,
  SimulationMode,
} from "../../shared/domain/types";
import type {
  OneAxisOutcome,
  SweepSample,
  TwoAxisOutcome,
} from "../../shared/domain/sweepTypes";
import type { AxisDraft, BudgetSweepController } from "./useBudgetSweep";

interface Props {
  project: LatencyProject;
  mode: SimulationMode;
  controller: BudgetSweepController;
}

const modeLabel: Record<SimulationMode, string> = {
  low: "乐观（低波动）",
  expected: "预期（中位）",
  high: "保守（高波动）",
};

function formatMs(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value < 1000
    ? `${Math.round(value)} ms`
    : `${(value / 1000).toFixed(2)} s`;
}

function formatValue(value: number, integer: boolean): string {
  return integer ? String(Math.round(value)) : String(Math.round(value * 100) / 100);
}

interface AxisFormProps {
  index: 1 | 2;
  draft: AxisDraft;
  options: { value: string; label: string }[];
  disabled: boolean;
  onChange: (draft: AxisDraft) => void;
}

function AxisForm({ index, draft, options, disabled, onChange }: AxisFormProps) {
  const patch = (partial: Partial<AxisDraft>) =>
    onChange({ ...draft, ...partial });
  const reversed = Number(draft.from) > Number(draft.to);
  return (
    <div className="sweep-axis-card">
      <div className="sweep-axis-head">
        <span className="sweep-axis-index">参数 {index}</span>
        <select
          value={draft.targetValue}
          disabled={disabled}
          onChange={(event) => patch({ targetValue: event.target.value })}
        >
          {options.map((option) => (
            <option key={option.value} value={option.label}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="sweep-axis-range">
        <label>
          <small>起点</small>
          <input
            type="number"
            value={draft.from}
            disabled={disabled}
            onChange={(event) => patch({ from: event.target.value })}
          />
        </label>
        <ArrowRight size={14} className={reversed ? "range-reversed" : ""} />
        <label>
          <small>终点</small>
          <input
            type="number"
            value={draft.to}
            disabled={disabled}
            onChange={(event) => patch({ to: event.target.value })}
          />
        </label>
        <label>
          <small>步长</small>
          <input
            type="number"
            min="0"
            value={draft.step}
            disabled={disabled}
            onChange={(event) => patch({ step: event.target.value })}
          />
        </label>
      </div>
      {reversed && (
        <p className="sweep-hint-warning">
          起点大于终点，将按从大到小扫描（系统已自动兼容，无需改写）。
        </p>
      )}
    </div>
  );
}

function ProgressBar({ evaluated, total }: { evaluated: number; total: number }) {
  const percent = total > 0 ? Math.round((evaluated / total) * 100) : 0;
  return (
    <div className="sweep-progress">
      <div className="sweep-progress-track">
        <i style={{ width: `${percent}%` }} />
      </div>
      <span>
        {evaluated} / {total} 个推演点 · {percent}%
      </span>
    </div>
  );
}

function CriticalChips({
  path,
  project,
}: {
  path: string[];
  project: LatencyProject;
}) {
  const names = path
    .map((id) => project.nodes.find((node) => node.id === id)?.name)
    .filter(Boolean);
  if (!names.length) return <span className="sweep-muted">无</span>;
  return (
    <div className="critical-chips">
      {names.map((name, index) => (
        <em key={`${name}-${index}`}>
          {index > 0 && <ArrowRight size={10} />}
          {name}
        </em>
      ))}
    </div>
  );
}

function SampleSummary({
  label,
  sample,
  project,
  over,
}: {
  label: string;
  sample: SweepSample;
  project: LatencyProject;
  over: boolean;
}) {
  return (
    <article className={`sweep-sample-card ${over ? "is-over" : "is-under"}`}>
      <span className="sweep-sample-tag">{label}</span>
      <strong>{formatMs(sample.completionMs)}</strong>
      <small>
        {sample.values.map((value, index) => (
          <span key={index} className="sweep-sample-values">
            {index > 0 ? " · " : ""}
            {formatValue(value, false)}
          </span>
        ))}
        {" · "}
        {over
          ? `超出 ${formatMs(-sample.headroomMs)}`
          : `剩余 ${formatMs(sample.headroomMs)}`}
      </small>
      <CriticalChips path={sample.criticalPath} project={project} />
    </article>
  );
}

function BracketSaveRow({
  markKey,
  side,
  values,
  pointText,
  defaultName,
  saved,
  onSave,
}: {
  markKey: string;
  side: "inside" | "outside";
  values: number[];
  pointText: string;
  defaultName: string;
  saved?: { name: string; saved: boolean };
  onSave: (key: string, side: "inside" | "outside", values: number[], name: string) => boolean;
}) {
  const [name, setName] = useState(defaultName);
  if (saved?.saved)
    return (
      <p className="sweep-saved-line">
        <Save size={13} /> 已存为方案快照：{saved.name}（{pointText}）
      </p>
    );
  return (
    <div className="sweep-save-row">
      <input value={name} onChange={(event) => setName(event.target.value)} />
      <button
        className="button button-neutral sweep-save-button"
        onClick={() => onSave(markKey, side, values, name)}
      >
        <Save size={13} /> 存为快照（{pointText}）
      </button>
    </div>
  );
}

function pointText(values: number[], metas: { unit: string; integer: boolean }[]): string {
  return values
    .map((value, index) => {
      const meta = metas[index] ?? { unit: "", integer: false };
      return `${formatValue(value, meta.integer)}${meta.unit}`;
    })
    .join(" / ");
}

function OneAxisResult({
  project,
  outcome,
  controller,
}: {
  project: LatencyProject;
  outcome: OneAxisOutcome;
  controller: BudgetSweepController;
}) {
  const { meta, bracket, conclusion } = outcome;
  const impact = controller.impactFor(bracket);
  return (
    <div className="sweep-result">
      {conclusion === "crossed" && bracket ? (
        <>
          <div className="sweep-threshold-banner">
            <Crosshair size={18} />
            <div>
              <strong>
                临界值：
                {bracket.precision === "exact" && bracket.threshold !== undefined
                  ? `${formatValue(bracket.threshold, false)} ${meta.unit}`
                  : `${formatValue(bracket.inside.values[0]!, meta.integer)} – ${formatValue(bracket.outside.values[0]!, meta.integer)} ${meta.unit}`}
              </strong>
              <small>
                {meta.label} 超过该值后整页预算即越线；
                {bracket.precision === "exact"
                  ? "已对连续参数做二分细化，误差 ≤ 0.5ms。"
                  : "整数参数按步长夹出临界区间。"}
              </small>
            </div>
          </div>
          <div className="sweep-bracket-grid">
            <SampleSummary
              label="临界点前 · 预算内"
              sample={bracket.inside}
              project={project}
              over={false}
            />
            <SampleSummary
              label="临界点后 · 已越线"
              sample={bracket.outside}
              project={project}
              over
            />
          </div>
          <div className="sweep-snapshot-box">
            <span className="section-label">存为方案快照用于对比</span>
            <BracketSaveRow
              markKey="one-inside"
              side="inside"
              values={bracket.inside.values}
              pointText={`${formatValue(bracket.inside.values[0]!, meta.integer)} ${meta.unit}`}
              defaultName={`${meta.label}=${formatValue(bracket.inside.values[0]!, meta.integer)} · 预算内`}
              saved={controller.savedMarks["one-inside"]}
              onSave={controller.saveBracketSnapshot}
            />
            <BracketSaveRow
              markKey="one-outside"
              side="outside"
              values={bracket.outside.values}
              pointText={`${formatValue(bracket.outside.values[0]!, meta.integer)} ${meta.unit}`}
              defaultName={`${meta.label}=${formatValue(bracket.outside.values[0]!, meta.integer)} · 越线点`}
              saved={controller.savedMarks["one-outside"]}
              onSave={controller.saveBracketSnapshot}
            />
          </div>
          {impact && (
            <div className="sweep-impact">
              <span className="section-label">临界点前后变化</span>
              {(impact.criticalAdded.length > 0 ||
                impact.criticalRemoved.length > 0) && (
                <div className="sweep-impact-chains">
                  {impact.criticalAdded.length > 0 && (
                    <p>
                      <b>进入关键链路：</b>
                      {impact.criticalAdded
                        .map((id) => project.nodes.find((n) => n.id === id)?.name ?? id)
                        .join("、")}
                    </p>
                  )}
                  {impact.criticalRemoved.length > 0 && (
                    <p>
                      <b>离开关键链路：</b>
                      {impact.criticalRemoved
                        .map((id) => project.nodes.find((n) => n.id === id)?.name ?? id)
                        .join("、")}
                    </p>
                  )}
                </div>
              )}
              {impact.criticalAdded.length === 0 &&
                impact.criticalRemoved.length === 0 && (
                  <p className="sweep-muted">关键链路节点未变，仅耗时被拉长。</p>
                )}
              <table className="sweep-impact-table">
                <thead>
                  <tr>
                    <th>最受影响节点</th>
                    <th>结束时间变化</th>
                    <th>自身耗时变化</th>
                    <th>关键链路</th>
                  </tr>
                </thead>
                <tbody>
                  {impact.affectedNodes.slice(0, 6).map((row) => (
                    <tr key={row.nodeId}>
                      <td>{row.name}</td>
                      <td className={row.endDeltaMs > 0 ? "delta-bad" : ""}>
                        {row.endDeltaMs > 0 ? "+" : ""}
                        {formatMs(row.endDeltaMs)}
                      </td>
                      <td>
                        {Math.abs(row.durationDeltaMs) > 0.01
                          ? `${row.durationDeltaMs > 0 ? "+" : ""}${formatMs(row.durationDeltaMs)}`
                          : "—（排队/传导）"}
                      </td>
                      <td>
                        {row.onCriticalBefore && !row.onCriticalAfter && "退出"}
                        {!row.onCriticalBefore && row.onCriticalAfter && "进入"}
                        {row.onCriticalBefore && row.onCriticalAfter && "始终在链路上"}
                        {!row.onCriticalBefore && !row.onCriticalAfter && "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <div className="sweep-conclusion-empty">
          <ShieldAlert size={20} />
          {conclusion === "always-inside" ? (
            <div>
              <strong>整个区间都在预算内</strong>
              <p>
                最慢一点完成时间 {formatMs(outcome.samples[outcome.samples.length - 1]?.completionMs ?? 0)}
                ，仍有余量。可以扩大扫描区间继续找边界。
              </p>
            </div>
          ) : (
            <div>
              <strong>起点处就已经超线</strong>
              <p>
                区间内最快一点也要 {formatMs(outcome.samples[0]?.completionMs ?? 0)}
                ，请向更小的参数方向扩大区间，或先优化链路。
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TwoAxisResult({
  project,
  outcome,
  controller,
}: {
  project: LatencyProject;
  outcome: TwoAxisOutcome;
  controller: BudgetSweepController;
}) {
  const { primary, secondary, boundaries, firstCross, alwaysInsideRows } = outcome;
  const [selectedRow, setSelectedRow] = useState(0);
  const activeBoundary = boundaries[selectedRow]?.bracket;
  const activeImpact = controller.impactFor(activeBoundary);
  const overCount = boundaries.filter((row) => row.bracket).length;

  const heatClass = (sample: SweepSample) => {
    if (!sample.overBudget) return "heat-under";
    const ratio = Math.min(
      1,
      (sample.completionMs - controller.effectiveBudget) /
        Math.max(1, controller.effectiveBudget),
    );
    return ratio > 0.25 ? "heat-over-hot" : "heat-over";
  };

  return (
    <div className="sweep-result">
      <div className="sweep-threshold-banner">
        <Crosshair size={18} />
        <div>
          <strong>
            {overCount > 0
              ? `${secondary.label} 的 ${overCount}/${boundaries.length} 个取值下存在临界点`
              : "整个参数面都没有越线"}
          </strong>
          <small>
            行为主轴：{primary.label}；对照轴：{secondary.label}。
            {firstCross
              ? ` 最宽松的越线组合为 ${primary.label}=${formatValue(firstCross.values[0]!, primary.integer)}${primary.unit}、${secondary.label}=${formatValue(firstCross.values[1]!, secondary.integer)}${secondary.unit}。`
              : alwaysInsideRows > 0
                ? ` 全部 ${alwaysInsideRows} 行均在预算内。`
                : ""}
          </small>
        </div>
      </div>

      <div className="sweep-heatmap-scroll">
        <table className="sweep-heatmap">
          <thead>
            <tr>
              <th>
                {secondary.label} ↓ / {primary.label} →
              </th>
              {primary.values.map((value, index) => (
                <th key={index}>{formatValue(value, primary.integer)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {boundaries.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th>{formatValue(row.fixedValue, secondary.integer)} {secondary.unit}</th>
                {outcome.samples
                  .slice(
                    rowIndex * primary.values.length,
                    (rowIndex + 1) * primary.values.length,
                  )
                  .map((sample, colIndex) => (
                    <td
                      key={colIndex}
                      className={`${heatClass(sample)} ${selectedRow === rowIndex ? "heat-selected-row" : ""}`}
                      title={`${primary.label}=${formatValue(sample.values[0]!, primary.integer)}${primary.unit}，${secondary.label}=${formatValue(sample.values[1]!, secondary.integer)}${secondary.unit}，完成 ${formatMs(sample.completionMs)}`}
                    >
                      {sample.overBudget ? "✕" : "·"}
                    </td>
                  ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <label className="sweep-row-picker">
        <span>查看 {secondary.label} 的临界细节：</span>
        <select
          value={selectedRow}
          onChange={(event) => setSelectedRow(Number(event.target.value))}
        >
          {boundaries.map((row, index) => (
            <option key={index} value={index}>
              {formatValue(row.fixedValue, secondary.integer)} {secondary.unit}
              {row.bracket
                ? ` · 临界 ${primary.label}=${
                    row.bracket.threshold !== undefined
                      ? formatValue(row.bracket.threshold, false)
                      : formatValue(row.bracket.outside.values[0]!, primary.integer)
                  }${primary.unit}`
                : " · 全区间预算内"}
            </option>
          ))}
        </select>
      </label>

      {activeBoundary ? (
        <>
          <div className="sweep-bracket-grid">
            <SampleSummary
              label="临界点前 · 预算内"
              sample={activeBoundary.inside}
              project={project}
              over={false}
            />
            <SampleSummary
              label="临界点后 · 已越线"
              sample={activeBoundary.outside}
              project={project}
              over
            />
          </div>
          <div className="sweep-snapshot-box">
            <span className="section-label">存为方案快照用于对比</span>
            <BracketSaveRow
              markKey={`two-inside-${selectedRow}`}
              side="inside"
              values={activeBoundary.inside.values}
              pointText={pointText(activeBoundary.inside.values, [primary, secondary])}
              defaultName={`${primary.label}=${formatValue(activeBoundary.inside.values[0]!, primary.integer)} · ${secondary.label}=${formatValue(activeBoundary.inside.values[1]!, secondary.integer)} · 预算内`}
              saved={controller.savedMarks[`two-inside-${selectedRow}`]}
              onSave={controller.saveBracketSnapshot}
            />
            <BracketSaveRow
              markKey={`two-outside-${selectedRow}`}
              side="outside"
              values={activeBoundary.outside.values}
              pointText={pointText(activeBoundary.outside.values, [primary, secondary])}
              defaultName={`${primary.label}=${formatValue(activeBoundary.outside.values[0]!, primary.integer)} · ${secondary.label}=${formatValue(activeBoundary.outside.values[1]!, secondary.integer)} · 越线点`}
              saved={controller.savedMarks[`two-outside-${selectedRow}`]}
              onSave={controller.saveBracketSnapshot}
            />
          </div>
          {activeImpact && (
            <div className="sweep-impact">
              <span className="section-label">临界点前后变化</span>
              {(activeImpact.criticalAdded.length > 0 ||
                activeImpact.criticalRemoved.length > 0) && (
                <div className="sweep-impact-chains">
                  {activeImpact.criticalAdded.length > 0 && (
                    <p>
                      <b>进入关键链路：</b>
                      {activeImpact.criticalAdded
                        .map((id) => project.nodes.find((n) => n.id === id)?.name ?? id)
                        .join("、")}
                    </p>
                  )}
                  {activeImpact.criticalRemoved.length > 0 && (
                    <p>
                      <b>离开关键链路：</b>
                      {activeImpact.criticalRemoved
                        .map((id) => project.nodes.find((n) => n.id === id)?.name ?? id)
                        .join("、")}
                    </p>
                  )}
                </div>
              )}
              <table className="sweep-impact-table">
                <thead>
                  <tr>
                    <th>最受影响节点</th>
                    <th>结束时间变化</th>
                    <th>自身耗时变化</th>
                    <th>关键链路</th>
                  </tr>
                </thead>
                <tbody>
                  {activeImpact.affectedNodes.slice(0, 6).map((row) => (
                    <tr key={row.nodeId}>
                      <td>{row.name}</td>
                      <td className={row.endDeltaMs > 0 ? "delta-bad" : ""}>
                        {row.endDeltaMs > 0 ? "+" : ""}
                        {formatMs(row.endDeltaMs)}
                      </td>
                      <td>
                        {Math.abs(row.durationDeltaMs) > 0.01
                          ? `${row.durationDeltaMs > 0 ? "+" : ""}${formatMs(row.durationDeltaMs)}`
                          : "—（排队/传导）"}
                      </td>
                      <td>
                        {row.onCriticalBefore && !row.onCriticalAfter && "退出"}
                        {!row.onCriticalBefore && row.onCriticalAfter && "进入"}
                        {row.onCriticalBefore && row.onCriticalAfter && "始终在链路上"}
                        {!row.onCriticalBefore && !row.onCriticalAfter && "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <p className="sweep-muted sweep-row-note">
          在 {secondary.label}={formatValue(boundaries[selectedRow]?.fixedValue ?? 0, secondary.integer)}
          {secondary.unit} 时，{primary.label} 取遍整个区间都没有超线。
        </p>
      )}
    </div>
  );
}

export default function SweepPanel({ project, mode, controller }: Props) {
  const running = controller.running;
  const canStart = controller.draftErrors.length === 0 && !running;
  return (
    <section className="module-page sweep-page">
      <div className="module-heading">
        <div>
          <span className="eyebrow">05 / BUDGET SWEEP</span>
          <h1>预算临界扫描</h1>
          <p>选定目标完成时间与一到两个参数，批量推演预算刚好越线的临界值。</p>
        </div>
        <div className="sweep-heading-actions">
          {running ? (
            <button className="button button-danger" onClick={controller.cancel}>
              <Square size={14} fill="currentColor" /> 停止扫描
            </button>
          ) : (
            <button
              className="button button-primary"
              disabled={!canStart}
              onClick={() => void controller.start()}
            >
              <ScanLine size={15} /> 开始扫描
            </button>
          )}
        </div>
      </div>

      <div className="sweep-config">
        <label className="sweep-budget-field">
          <span className="toolbar-label">目标完成时间（整页预算）</span>
          <span className="number-wrap">
            <input
              type="number"
              min="1"
              placeholder={String(Math.round(controller.baselineCompletion))}
              value={controller.budgetText}
              disabled={running}
              onChange={(event) => controller.setBudgetText(event.target.value)}
            />
            <small>ms</small>
          </span>
          <small className="field-note">
            留空则以当前{modeLabel[mode]}完成时间 {formatMs(controller.baselineCompletion)} 为预算。
          </small>
        </label>
        <div className="sweep-mode-note">预算假设：{modeLabel[mode]}</div>
      </div>

      <div className="sweep-axes">
        <AxisForm
          index={1}
          draft={controller.axisA}
          options={controller.targetOptions}
          disabled={running}
          onChange={controller.setAxisA}
        />
        <div className="sweep-second-axis">
          <label className="sweep-toggle">
            <input
              type="checkbox"
              checked={controller.axisBEnabled}
              disabled={running}
              onChange={(event) => controller.setAxisBEnabled(event.target.checked)}
            />
            <span>同时扫描第二个参数（组成参数面）</span>
          </label>
          {controller.axisBEnabled && (
            <AxisForm
              index={2}
              draft={controller.axisB}
              options={controller.targetOptions}
              disabled={running}
              onChange={controller.setAxisB}
            />
          )}
        </div>
      </div>

      {controller.draftErrors.length > 0 && !running && (
        <div className="sweep-feedback sweep-feedback-error">
          <AlertTriangle size={15} />
          <ul>
            {controller.draftErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      {controller.errors.length > 0 && !running && (
        <div className="sweep-feedback sweep-feedback-error">
          <AlertTriangle size={15} />
          <ul>
            {controller.errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      {controller.warnings.length > 0 && (
        <div className="sweep-feedback sweep-feedback-warning">
          <AlertTriangle size={15} />
          <ul>
            {controller.warnings.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}

      {running && (
        <div className="sweep-running-card">
          <strong>正在后台推演，界面仍可操作</strong>
          <ProgressBar
            evaluated={controller.progress.evaluated}
            total={controller.progress.total}
          />
          <small>可随时停止；停止不会给出不完整的结论。</small>
        </div>
      )}
      {controller.cancelled && !running && (
        <div className="sweep-feedback sweep-feedback-warning">
          <Square size={15} />
          <span>扫描已停止，未产出任何结论；调整参数后可重新开始。</span>
        </div>
      )}

      {controller.outcome?.kind === "one" && (
        <OneAxisResult project={project} outcome={controller.outcome} controller={controller} />
      )}
      {controller.outcome?.kind === "two" && (
        <TwoAxisResult project={project} outcome={controller.outcome} controller={controller} />
      )}

      <div className="model-footnote">
        扫描在当前链路副本上按步长批量调用确定性推演，连续参数的临界值用二分法细化；
        每次最多 {MAX_GRID_POINTS.toLocaleString()} 个推演点，超限请缩小区间或放大步长。快照可在「方案对比」中直接 A/B。
      </div>
    </section>
  );
}
