import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProjectRepository } from "../../shared/repositories/projectRepository";
import type {
  LatencyProject,
  SimulationMode,
  WorkspaceDocument,
} from "../../shared/domain/types";
import {
  createProject,
  duplicateProject,
  renameProject,
  selectProject,
} from "../projects/projectViewModel";
import {
  addRequestNode,
  patchRequestNode,
  removeRequestNode,
  setConcurrency,
  toggleDependency,
  getGraphAnalysis,
} from "../graph-editor/graphViewModel";
import {
  compareScenarios,
  removeScenario,
  restoreScenario,
  saveScanBoundaryScenarios,
  saveScenario,
  type ScenarioComparison,
} from "../scenarios/scenarioViewModel";
import { removeProject, updateProject } from "../projects/projectViewModel";
import { simulateProject } from "../../shared/domain/simulation";
import {
  runBudgetScan,
  type BudgetScanResult,
  type ScanAxisRequest,
} from "../../shared/domain/scan";

export type LabStatus =
  | "loading"
  | "ready"
  | "editing"
  | "simulating"
  | "scanning"
  | "error"
  | "completed"
  | "cancelled";
export type LabModule =
  "projects" | "graph" | "simulation" | "scan" | "scenarios" | "archive";

export function useLatencyLab() {
  const repository = useMemo(() => new ProjectRepository(), []);
  const [document, setDocument] = useState<WorkspaceDocument | null>(null);
  const documentRef = useRef<WorkspaceDocument | null>(null);
  const [status, setStatus] = useState<LabStatus>("loading");
  const [module, setModule] = useState<LabModule>("simulation");
  const [mode, setMode] = useState<SimulationMode>("expected");
  const [comparisonIds, setComparisonIds] = useState<{
    baselineId: string;
    comparisonId: string;
  }>({ baselineId: "", comparisonId: "" });
  const [notice, setNotice] = useState("");
  const [scanResult, setScanResult] = useState<BudgetScanResult | null>(null);
  const [scanProgress, setScanProgress] = useState({
    completed: 0,
    total: 0,
  });
  const scanRunId = useRef(0);
  const scanAbortRef = useRef<{ aborted: boolean } | null>(null);
  const scanSourceRef = useRef<LatencyProject | null>(null);
  const [persisted, setPersisted] = useState<"saving" | "saved" | "error">(
    "saved",
  );
  const queue = useRef(Promise.resolve());
  const revision = useRef(0);
  const activeProject =
    document?.projects.find(
      (project) => project.id === document.activeProjectId,
    ) ?? document?.projects[0];
  const result = useMemo(
    () => (activeProject ? simulateProject(activeProject, mode) : undefined),
    [activeProject, mode],
  );
  const graphAnalysis = useMemo(
    () => (activeProject ? getGraphAnalysis(activeProject) : undefined),
    [activeProject],
  );
  const scenarioList = activeProject?.scenarios ?? [];
  const baselineScenario =
    scenarioList.find((scenario) => scenario.id === comparisonIds.baselineId) ??
    scenarioList[1] ??
    scenarioList[0];
  const comparisonScenario =
    scenarioList.find(
      (scenario) => scenario.id === comparisonIds.comparisonId,
    ) ?? scenarioList[0];
  const scenarioComparison: ScenarioComparison | undefined =
    baselineScenario && comparisonScenario
      ? compareScenarios(baselineScenario, comparisonScenario)
      : undefined;
  const simulationValid =
    Boolean(activeProject) &&
    result?.entries.length === activeProject?.nodes.length;

  useEffect(() => {
    if (scanAbortRef.current) scanAbortRef.current.aborted = true;
    scanAbortRef.current = null;
    scanRunId.current += 1;
    setScanResult(null);
    setScanProgress({ completed: 0, total: 0 });
    scanSourceRef.current = null;
  }, [activeProject?.id]);

  const selectComparisonScenario = useCallback(
    (side: "baselineId" | "comparisonId", id: string) => {
      setComparisonIds((current) => ({ ...current, [side]: id }));
    },
    [],
  );

  useEffect(() => {
    let mounted = true;
    void repository
      .load()
      .then(({ document: loaded, recovered }) => {
        if (!mounted) return;
        documentRef.current = loaded;
        setDocument(loaded);
        setStatus("ready");
        if (recovered)
          setNotice("已载入示例工作区；后续修改会自动保存到此设备。");
      })
      .catch(() => {
        if (!mounted) return;
        setStatus("error");
        setNotice("本地项目读取失败，刷新页面可再次尝试。");
      });
    return () => {
      mounted = false;
    };
  }, [repository]);

  const commit = useCallback(
    (next: WorkspaceDocument, nextStatus: LabStatus = "editing") => {
      const currentRevision = ++revision.current;
      documentRef.current = next;
      setDocument(next);
      setStatus(nextStatus);
      setNotice("");
      setPersisted("saving");
      queue.current = queue.current
        .then(() => repository.save(next))
        .then(() => {
          if (revision.current === currentRevision) {
            setPersisted("saved");
            if (nextStatus === "editing") setStatus("completed");
          }
        })
        .catch(() => {
          if (revision.current === currentRevision) {
            setPersisted("error");
            setStatus("error");
            setNotice("保存失败。数据仍保留在当前页面，请重试保存。");
          }
        });
    },
    [repository],
  );

  const editProject = useCallback(
    (project: LatencyProject) => {
      const current = documentRef.current;
      if (current) commit(updateProject(current, project));
    },
    [commit],
  );

  const chooseProject = useCallback(
    (id: string) => {
      const current = documentRef.current;
      if (current) commit(selectProject(current, id), "ready");
    },
    [commit],
  );

  const newProject = useCallback(() => {
    const current = documentRef.current;
    if (current) commit(createProject(current), "editing");
  }, [commit]);

  const renameActive = useCallback(
    (title: string) => {
      if (activeProject) editProject(renameProject(activeProject, title));
    },
    [activeProject, editProject],
  );

  const duplicateActive = useCallback(() => {
    const current = documentRef.current;
    if (current && activeProject)
      commit(duplicateProject(current, activeProject), "editing");
  }, [activeProject, commit]);

  const deleteProject = useCallback(
    (id: string) => {
      const current = documentRef.current;
      if (current && current.projects.length > 1)
        commit(removeProject(current, id), "editing");
      else setNotice("至少保留一个链路项目。");
    },
    [commit],
  );

  const addNode = useCallback(() => {
    if (activeProject) editProject(addRequestNode(activeProject));
  }, [activeProject, editProject]);
  const patchNode = useCallback(
    (id: string, patch: Parameters<typeof patchRequestNode>[2]) => {
      if (activeProject)
        editProject(patchRequestNode(activeProject, id, patch));
    },
    [activeProject, editProject],
  );
  const deleteNode = useCallback(
    (id: string) => {
      if (activeProject) editProject(removeRequestNode(activeProject, id));
    },
    [activeProject, editProject],
  );
  const setNodeDependency = useCallback(
    (id: string, dependencyId: string) => {
      if (!activeProject) return;
      const outcome = toggleDependency(activeProject, id, dependencyId);
      if (outcome.error) setNotice(outcome.error);
      else editProject(outcome.project);
    },
    [activeProject, editProject],
  );
  const setLimit = useCallback(
    (limit: number | null) => {
      if (activeProject) editProject(setConcurrency(activeProject, limit));
    },
    [activeProject, editProject],
  );

  const simulate = useCallback(
    (nextMode = mode) => {
      if (!activeProject) return undefined;
      setStatus("simulating");
      const result = simulateProject(activeProject, nextMode);
      setMode(nextMode);
      setStatus(
        result.warnings.some((warning) => warning.includes("循环"))
          ? "error"
          : "completed",
      );
      return result;
    },
    [activeProject, mode],
  );

  const runScan = useCallback(
    async (
      targetMs: number,
      axes: ScanAxisRequest[],
    ): Promise<BudgetScanResult | undefined> => {
      if (!activeProject) return undefined;
      if (scanAbortRef.current) scanAbortRef.current.aborted = true;
      const sourceProject = structuredClone(activeProject);
      const runId = ++scanRunId.current;
      const signal = { aborted: false };
      scanAbortRef.current = signal;
      scanSourceRef.current = sourceProject;
      setScanResult(null);
      setScanProgress({ completed: 0, total: 0 });
      setStatus("scanning");
      setNotice("");
      const scan = await runBudgetScan(
        {
          project: sourceProject,
          mode,
          targetMs,
          axes: axes.length === 1 ? [axes[0]!] : [axes[0]!, axes[1]!],
        },
        {
          signal,
          onProgress: (completed, total) => {
            if (scanRunId.current === runId)
              setScanProgress({ completed, total });
          },
        },
      );
      if (scanRunId.current !== runId) return undefined;
      setScanResult(scan);
      if (scan.status === "invalid") {
        setStatus("error");
        setNotice(scan.errors[0] ?? "扫描参数无效，请调整后重试。");
      } else if (scan.status === "cancelled") {
        setStatus("cancelled");
        setNotice("扫描已取消，未使用部分推演结果生成结论。");
      } else {
        setStatus("completed");
        setNotice(
          scan.outcome === "crossed"
            ? `扫描完成：已推演 ${scan.totalPoints.toLocaleString("zh-CN")} 个参数组合并找到临界边界。`
            : `扫描完成：已完整推演 ${scan.totalPoints.toLocaleString("zh-CN")} 个参数组合，但该区间内${scan.outcome === "all-safe" ? "始终未超线" : "一开始就已超线"}。`,
        );
      }
      return scan;
    },
    [activeProject, mode],
  );

  const cancelScan = useCallback(() => {
    if (scanAbortRef.current) scanAbortRef.current.aborted = true;
    scanRunId.current += 1;
    setStatus("cancelled");
    setNotice("正在停止扫描；已完成的部分不会作为结论。");
  }, []);

  const saveScanSnapshots = useCallback((): boolean => {
    const sourceProject = scanSourceRef.current;
    if (
      !sourceProject ||
      !activeProject ||
      sourceProject.id !== activeProject.id ||
      !scanResult ||
      scanResult.status !== "completed" ||
      !scanResult.boundary
    ) {
      setNotice("只有找到临界边界的完整扫描才能保存临界点快照。");
      return false;
    }
    const current = documentRef.current;
    if (!current) return false;
    const withScenarios = saveScanBoundaryScenarios(
      activeProject,
      sourceProject,
      scanResult.boundary,
      scanResult.targetMs,
      scanResult.mode,
    );
    const scenarioIds = withScenarios.scenarios
      .slice(0, 2)
      .map((item) => item.id);
    const next = updateProject(current, withScenarios);
    commit(next, "completed");
    setComparisonIds({
      baselineId: scenarioIds[1] ?? "",
      comparisonId: scenarioIds[0] ?? "",
    });
    setNotice("临界前与越线点两份方案快照已保存，可在方案对比中查看。");
    return true;
  }, [activeProject, commit, scanResult]);

  const saveSnapshot = useCallback(
    (name: string): boolean => {
      if (!activeProject) return false;
      const result = simulateProject(activeProject, mode);
      if (result.entries.length !== activeProject.nodes.length) {
        setNotice(result.warnings[0] ?? "请先修复链路配置再保存方案。");
        return false;
      }
      const next = saveScenario(activeProject, result, name);
      editProject(next);
      setComparisonIds({
        baselineId: next.scenarios[1]?.id ?? next.scenarios[0]?.id ?? "",
        comparisonId: next.scenarios[0]?.id ?? "",
      });
      setNotice("方案快照已保存。");
      return true;
    },
    [activeProject, editProject, mode],
  );

  const removeSavedScenario = useCallback(
    (id: string) => {
      if (activeProject) editProject(removeScenario(activeProject, id));
    },
    [activeProject, editProject],
  );
  const restoreSavedScenario = useCallback(
    (id: string) => {
      if (activeProject) editProject(restoreScenario(activeProject, id));
    },
    [activeProject, editProject],
  );

  const retrySave = useCallback(() => {
    const current = documentRef.current;
    if (current) commit(current);
  }, [commit]);

  return {
    document,
    activeProject,
    result,
    graphAnalysis,
    simulationValid,
    status,
    module,
    setModule,
    mode,
    setMode,
    notice,
    setNotice,
    persisted,
    chooseProject,
    newProject,
    renameActive,
    duplicateActive,
    deleteProject,
    addNode,
    patchNode,
    deleteNode,
    setNodeDependency,
    setLimit,
    simulate,
    scanResult,
    scanProgress,
    runScan,
    cancelScan,
    saveScanSnapshots,
    saveSnapshot,
    removeSavedScenario,
    restoreSavedScenario,
    retrySave,
    scenarioList,
    baselineScenario,
    comparisonScenario,
    scenarioComparison,
    selectComparisonScenario,
  };
}
