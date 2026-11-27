import { describe, expect, it } from "vitest";
import { calculateReliabilityMetrics } from "../src/server/phase4/analytics";

const start = new Date("2026-01-01T00:00:00.000Z");
const window = (seconds: number) => new Date(start.getTime() + seconds * 1000);
const event = (id: string, from: number, to: number | null) => ({
  id,
  startedAt: window(from),
  endedAt: to === null ? null : window(to),
});

describe("equipment reliability metrics", () => {
  it("reports full availability and undefined reliability intervals when there are no failures", () => {
    expect(calculateReliabilityMetrics([],start,window(100))).toEqual({
      windowSeconds: 100,
      downtimeSeconds: 0,
      availabilityPercent: 100,
      failureCount: 0,
      closedFailureCount: 0,
      ongoingFailureCount: 0,
      mtbfSeconds: null,
      mttrSeconds: null,
    });
  });

  it("clips downtime to the window and unions overlaps rather than double-counting them", () => {
    const metrics = calculateReliabilityMetrics([
      event("starts-before-window",-50,100),
      event("overlap",50,200),
      event("ends-at-window-end",1000,1200),
    ],start,window(1000));

    expect(metrics.downtimeSeconds).toBe(200);
    expect(metrics.availabilityPercent).toBe(80);
    expect(metrics.failureCount).toBe(1);
    expect(metrics.mttrSeconds).toBe(150);
    expect(metrics.mtbfSeconds).toBe(800);
  });

  it("counts an ongoing failure through the end of the observation window", () => {
    const metrics = calculateReliabilityMetrics([
      event("completed",100,200),
      event("ongoing",400,null),
    ],start,window(1000));

    expect(metrics.downtimeSeconds).toBe(700);
    expect(metrics.ongoingFailureCount).toBe(1);
    expect(metrics.closedFailureCount).toBe(1);
    expect(metrics.mttrSeconds).toBe(100);
    expect(metrics.mtbfSeconds).toBe(150);
  });

  it("excludes zero-duration events at the right boundary", () => {
    const metrics = calculateReliabilityMetrics([event("boundary",1000,null)],start,window(1000));
    expect(metrics.downtimeSeconds).toBe(0);
    expect(metrics.failureCount).toBe(0);
    expect(metrics.ongoingFailureCount).toBe(0);
  });
});
