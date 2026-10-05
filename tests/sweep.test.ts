import { describe, expect, it } from "vitest";
import { EXAMPLE_PROJECT } from "../src/shared/domain/types";
import type { LatencyProject } from "../src/shared/domain/types";
import type { SweepRequest } from "../src/shared/domain/sweepTypes";
import {
  MAX_GRID_POINTS,
  describeBracketImpact,
  projectAtSweepPoint,
  runSweep,
  validateSweep,
} from "../src/shared/domain/sweep";

const project: LatencyProject = structuredClone(EXAMPLE_PROJECT);

function axis(
  nodeId: string,
  field: "durationMs" | "failureRate" | "retryCount",
  from: number,
  to: number,
  step: number,
) {
  return {
    id: `axis-${nodeId}-${field}`,
    target: { kind: "node" as const, nodeId, field },
    from,
    to,
    step,
  };
}

describe("budget sweep validation", () => {
  it("accepts a reversed range and scans from high to low", () => {
    const request: SweepRequest = {
      budgetMs: 2000,
      mode: "expected",
      axes: [axis("catalog", "durationMs", 1200, 200, 50)],
    };
    const validation = validateSweep(project, request);
    expect(validation.errors).toHaveLength(0);
    // 取值仍按小到大排列以便找临界点，但方向保留用户的从大到小意图
    expect(validation.metas[0]?.values[0]).toBe(200);
    expect(validation.metas[0]?.values.at(-1)).toBe(1200);
    expect(validation.metas[0]?.direction).toBe("decrease");
  });

  it("rejects scans larger than the point cap with an actionable message", () => {
    const request: SweepRequest = {
      budgetMs: 2000,
      mode: "expected",
      axes: [
        axis("catalog", "durationMs", 0, 1990, 10),
        axis("profile", "durationMs", 0, 1990, 10),
      ],
    };
    const validation = validateSweep(project, request);
    expect(validation.errors.join(" ")).toContain(MAX_GRID_POINTS.toLocaleString());
  });

  it("rejects a non-positive step, identical bounds, and duplicate targets", () => {
    const broken: SweepRequest = {
      budgetMs: 2000,
      mode: "expected",
      axes: [axis("catalog", "durationMs", 100, 200, 0)],
    };
    expect(validateSweep(project, broken).errors.join(" ")).toContain("步长");
    const sameBounds: SweepRequest = {
      budgetMs: 2000,
      mode: "expected",
      axes: [axis("catalog", "durationMs", 300, 300, 10)],
    };
    expect(validateSweep(project, sameBounds).errors.join(" ")).toContain("不能相同");
    const duplicate: SweepRequest = {
      budgetMs: 2000,
      mode: "expected",
      axes: [
        axis("catalog", "durationMs", 100, 200, 10),
        axis("catalog", "durationMs", 200, 400, 10),
      ],
    };
    expect(validateSweep(project, duplicate).errors.join(" ")).toContain("同一个字段");
  });

  it("blocks scanning when the graph itself has errors", () => {
    const cyclic: LatencyProject = {
      ...project,
      nodes: project.nodes.map((node) =>
        node.id === "session"
          ? { ...node, dependencyIds: ["catalog"] }
          : node,
      ),
    };
    const request: SweepRequest = {
      budgetMs: 2000,
      mode: "expected",
      axes: [axis("catalog", "durationMs", 100, 900, 50)],
    };
    expect(validateSweep(cyclic, request).errors.join(" ")).toContain(
      "链路存在配置问题",
    );
  });

  it("clamps concurrency values above the node count", () => {
    const request: SweepRequest = {
      budgetMs: 2000,
      mode: "expected",
      axes: [
        {
          id: "concurrency-axis",
          target: { kind: "concurrency" },
          from: 1,
          to: 12,
          step: 1,
        },
      ],
    };
    const validation = validateSweep(project, request);
    expect(validation.errors).toHaveLength(0);
    expect(validation.warnings.join(" ")).toContain("裁剪");
    expect(validation.metas[0]?.values.at(-1)).toBe(project.nodes.length);
  });
});

describe("budget sweep execution", () => {
  it("finds and refines the crossing point along one increasing axis", async () => {
    const request: SweepRequest = {
      budgetMs: 1700,
      mode: "expected",
      axes: [axis("profile", "durationMs", 300, 800, 50)],
    };
    const validation = validateSweep(project, request);
    const outcome = await runSweep(project, request, validation, {
      chunkSize: 4,
    });
    expect(outcome?.kind).toBe("one");
    if (outcome?.kind !== "one") throw new Error("expected one-axis outcome");
    expect(outcome.conclusion).toBe("crossed");
    expect(outcome.bracket?.inside.overBudget).toBe(false);
    expect(outcome.bracket?.outside.overBudget).toBe(true);
    expect(outcome.bracket?.precision).toBe("exact");
    // 关键链路 session → profile → recommend；profile 临界约 615ms
    expect(outcome.bracket?.threshold).toBeGreaterThan(600);
    expect(outcome.bracket?.threshold).toBeLessThan(635);
  });

  it("reports always-inside and always-outside ranges without inventing a threshold", async () => {
    const inside: SweepRequest = {
      budgetMs: 5000,
      mode: "high",
      axes: [axis("catalog", "durationMs", 100, 400, 50)],
    };
    const insideOutcome = await runSweep(
      project,
      inside,
      validateSweep(project, inside),
    );
    expect(insideOutcome?.kind).toBe("one");
    if (insideOutcome?.kind !== "one") throw new Error("one-axis expected");
    expect(insideOutcome.conclusion).toBe("always-inside");
    expect(insideOutcome.bracket).toBeUndefined();

    const outside: SweepRequest = {
      budgetMs: 1000,
      mode: "expected",
      axes: [axis("profile", "durationMs", 300, 500, 50)],
    };
    const outsideOutcome = await runSweep(
      project,
      outside,
      validateSweep(project, outside),
    );
    if (outsideOutcome?.kind !== "one") throw new Error("one-axis expected");
    expect(outsideOutcome.conclusion).toBe("always-outside");
    expect(outsideOutcome.bracket).toBeUndefined();
  });

  it("scans a two-axis grid and reports per-row boundaries", async () => {
    const request: SweepRequest = {
      budgetMs: 1700,
      mode: "expected",
      axes: [
        axis("profile", "durationMs", 300, 1100, 100),
        axis("catalog", "durationMs", 300, 700, 100),
      ],
    };
    const outcome = await runSweep(
      project,
      request,
      validateSweep(project, request),
    );
    expect(outcome?.kind).toBe("two");
    if (outcome?.kind !== "two") throw new Error("two-axis expected");
    expect(outcome.samples).toHaveLength(9 * 5);
    expect(outcome.boundaries).toHaveLength(5);
    expect(outcome.boundaries.some((row) => row.bracket)).toBe(true);
    // 每个有临界点的行，inside 与 outside 确实相邻且预算判定相反
    for (const row of outcome.boundaries) {
      if (!row.bracket) continue;
      expect(row.bracket.inside.overBudget).toBe(false);
      expect(row.bracket.outside.overBudget).toBe(true);
    }
  });

  it("stops without a partial result when aborted", async () => {
    const controller = new AbortController();
    const request: SweepRequest = {
      budgetMs: 1100,
      mode: "expected",
      axes: [axis("catalog", "durationMs", 100, 1000, 10)],
    };
    const promise = runSweep(
      project,
      request,
      validateSweep(project, request),
      { signal: controller.signal, chunkSize: 1 },
    );
    controller.abort();
    const outcome = await promise;
    expect(outcome).toBeUndefined();
  });

  it("exposes the project at a sweep point and the bracket impact", async () => {
    const sweepAxis = axis("profile", "durationMs", 300, 800, 50);
    const request: SweepRequest = {
      budgetMs: 1700,
      mode: "expected",
      axes: [sweepAxis],
    };
    const candidate = projectAtSweepPoint(project, [sweepAxis], [700]);
    expect(candidate.nodes.find((n) => n.id === "profile")?.durationMs).toBe(
      700,
    );
    expect(candidate.scenarios).toBe(project.scenarios);

    const outcome = await runSweep(
      project,
      request,
      validateSweep(project, request),
    );
    if (outcome?.kind !== "one" || !outcome.bracket)
      throw new Error("bracket expected");
    const impact = describeBracketImpact(project, outcome.bracket);
    const profileImpact = impact.affectedNodes.find(
      (row) => row.nodeId === "profile",
    );
    expect(profileImpact?.durationDeltaMs).toBeGreaterThan(0);
    // recommend 自身耗时不变，但结束时间随 profile 后移，属于“传导”受影响
    const recommendImpact = impact.affectedNodes.find(
      (row) => row.nodeId === "recommend",
    );
    expect(recommendImpact?.durationDeltaMs ?? 0).toBe(0);
    expect(recommendImpact?.endDeltaMs).toBeGreaterThan(0);
    expect(impact.affectedNodes[0]?.nodeId).toBeDefined();
  });
});
