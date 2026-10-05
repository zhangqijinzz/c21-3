import { describe, expect, it } from "vitest";
import {
  buildProjectAtPoint,
  runBudgetScan,
  type ScanAxisRequest,
  type ScanRequest,
} from "../src/shared/domain/scan";
import { saveScanBoundaryScenarios } from "../src/features/scenarios/scenarioViewModel";
import type { LatencyProject, RequestNode } from "../src/shared/domain/types";

function makeNode(
  id: string,
  name: string,
  durationMs: number,
  dependencyIds: string[] = [],
): RequestNode {
  return {
    id,
    name,
    durationMs,
    jitterMs: 0,
    dependencyIds,
    timeoutMs: 10_000,
    retryCount: 0,
    failureRate: 0,
  };
}

function makeProject(
  nodes: RequestNode[],
  concurrencyLimit: number | null = null,
): LatencyProject {
  return {
    id: "scan-project",
    title: "扫描测试",
    nodes,
    concurrencyLimit,
    scenarios: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function scanRequest(
  project: LatencyProject,
  targetMs: number,
  axes: ScanAxisRequest[],
): ScanRequest {
  return {
    project,
    mode: "expected",
    targetMs,
    axes: axes.length === 1 ? [axes[0]!] : [axes[0]!, axes[1]!],
  };
}

describe("budget boundary scan", () => {
  it("finds the adjacent safe and breached points for one parameter", async () => {
    const project = makeProject([
      makeNode("a", "入口", 100),
      makeNode("b", "资料", 100, ["a"]),
    ]);
    const result = await runBudgetScan(
      scanRequest(project, 300, [
        {
          parameterKey: "durationMs",
          nodeId: "b",
          start: 100,
          end: 300,
          step: 50,
        },
      ]),
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.outcome).toBe("crossed");
    expect(result.boundary?.safePoint.values[0]?.value).toBe(200);
    expect(result.boundary?.breachPoint.values[0]?.value).toBe(250);
    expect(result.boundary?.estimatedValue).toBe(200);
    expect(result.boundary?.thresholdLabel).toContain("资料 · 基础耗时");
    expect(result.totalPoints).toBe(5);
  });

  it("supports parameters whose safer side is the larger value, such as concurrency", async () => {
    const project = makeProject([
      makeNode("a", "接口 A", 300),
      makeNode("b", "接口 B", 300),
    ]);
    const result = await runBudgetScan(
      scanRequest(project, 400, [
        { parameterKey: "concurrency", start: 2, end: 1, step: 1 },
      ]),
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.boundary?.safePoint.values[0]?.value).toBe(2);
    expect(result.boundary?.breachPoint.values[0]?.value).toBe(1);
    expect(result.boundary?.estimatedValue).toBeCloseTo(5 / 3);
  });

  it("treats a larger timeout cap as the higher-risk direction in this model", async () => {
    const node = makeNode("a", "接口", 300);
    node.jitterMs = 200;
    node.timeoutMs = 200;
    const project = makeProject([node]);
    const result = await runBudgetScan(
      scanRequest(project, 350, [
        {
          parameterKey: "timeoutMs",
          nodeId: "a",
          start: 200,
          end: 500,
          step: 100,
        },
      ]),
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.outcome).toBe("crossed");
    expect(result.boundary?.safePoint.values[0]?.value).toBe(300);
    expect(result.boundary?.breachPoint.values[0]?.value).toBe(400);
  });

  it("reports a reversed risk-increasing interval without silently swapping it", async () => {
    const project = makeProject([makeNode("a", "入口", 100)]);
    const result = await runBudgetScan(
      scanRequest(project, 300, [
        {
          parameterKey: "durationMs",
          nodeId: "a",
          start: 300,
          end: 100,
          step: 50,
        },
      ]),
    );
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.errors.join(" ")).toContain("区间方向写反");
  });

  it("refuses oversized scans before producing a partial conclusion", async () => {
    const project = makeProject([makeNode("a", "入口", 100)]);
    const result = await runBudgetScan(
      scanRequest(project, 300, [
        {
          parameterKey: "durationMs",
          nodeId: "a",
          start: 0,
          end: 1000,
          step: 1,
        },
      ]),
    );
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.errors.join(" ")).toContain("1,001");
    expect(result.errors.join(" ")).toContain("1,000");
  });

  it("stops cancellation without exposing partial boundary results", async () => {
    const project = makeProject([makeNode("a", "入口", 100)]);
    const signal = { aborted: true };
    const result = await runBudgetScan(
      scanRequest(project, 300, [
        {
          parameterKey: "durationMs",
          nodeId: "a",
          start: 100,
          end: 300,
          step: 50,
        },
      ]),
      { signal },
    );
    expect(result.status).toBe("cancelled");
    if (result.status !== "cancelled") return;
    expect(result.completedPoints).toBe(0);
  });

  it("surfaces graph errors and identifies affected nodes in a two-parameter scan", async () => {
    const valid = makeProject([
      makeNode("a", "接口 A", 300),
      makeNode("b", "接口 B", 300),
    ]);
    const cyclic: LatencyProject = {
      ...valid,
      nodes: [
        { ...valid.nodes[0]!, dependencyIds: ["b"] },
        { ...valid.nodes[1]!, dependencyIds: ["a"] },
      ],
    };
    const invalid = await runBudgetScan(
      scanRequest(cyclic, 500, [
        {
          parameterKey: "durationMs",
          nodeId: "a",
          start: 300,
          end: 500,
          step: 100,
        },
      ]),
    );
    expect(invalid.status).toBe("invalid");
    if (invalid.status !== "invalid") return;
    expect(invalid.errors.join(" ")).toContain("循环依赖");

    const result = await runBudgetScan(
      scanRequest(valid, 400, [
        {
          parameterKey: "durationMs",
          nodeId: "a",
          start: 300,
          end: 500,
          step: 100,
        },
        {
          parameterKey: "durationMs",
          nodeId: "b",
          start: 300,
          end: 500,
          step: 100,
        },
      ]),
    );
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.boundarySegments.length).toBe(4);
    expect(result.boundary?.affectedNodes[0]?.nodeName).toBe("接口 B");
    expect(result.boundary?.affectedNodes[0]?.deltaEndMs).toBe(100);
  });

  it("saves both boundary snapshots while leaving the working graph unchanged", async () => {
    const project = makeProject([
      makeNode("a", "入口", 100),
      makeNode("b", "资料", 100, ["a"]),
    ]);
    const result = await runBudgetScan(
      scanRequest(project, 300, [
        {
          parameterKey: "durationMs",
          nodeId: "b",
          start: 100,
          end: 300,
          step: 50,
        },
      ]),
    );
    if (result.status !== "completed" || !result.boundary)
      throw new Error("scan should complete");
    const saved = saveScanBoundaryScenarios(
      project,
      project,
      result.boundary,
      result.targetMs,
      result.mode,
    );
    expect(saved.scenarios).toHaveLength(2);
    expect(saved.scenarios[0]?.scan?.point).toBe("breached");
    expect(saved.scenarios[1]?.scan?.point).toBe("safe");
    expect(saved.nodes.find((node) => node.id === "b")?.durationMs).toBe(100);
    const breachedProject = {
      ...saved,
      nodes: structuredClone(saved.scenarios[0]!.nodes),
      concurrencyLimit: saved.scenarios[0]!.concurrencyLimit,
    };
    const pointProject = buildProjectAtPoint(
      project,
      result.boundary.breachPoint,
    );
    expect(breachedProject.nodes).toEqual(pointProject.nodes);
  });
});
