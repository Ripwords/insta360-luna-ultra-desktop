import { describe, expect, it } from "vitest";
import {
  DEFAULT_FOLLOWER,
  GIMBAL_DEG_PER_SEC_PER_UNIT,
  HeadFollower,
  type HeadPose,
  wrapDegrees,
} from "~/utils/headTracking";

const pose = (yaw: number, pitch = 0): HeadPose => ({ yaw, pitch, roll: 0 });
const TICK = 0.02; // CoreMotion delivers headphone motion at 50 Hz

/** The follower stops once inside the deadband, so it settles at most that far short. */
const near = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(DEFAULT_FOLLOWER.deadband);

/** Feed `pose` for `seconds`; returns the last command. */
function hold(follower: HeadFollower, at: HeadPose, seconds: number) {
  let last = { pan: 0, tilt: 0 };
  for (let t = 0; t < seconds; t += TICK) last = follower.step(at, TICK);
  return last;
}

describe("wrapDegrees", () => {
  it("keeps angles in -180..180", () => {
    expect(wrapDegrees(190)).toBe(-170);
    expect(wrapDegrees(-190)).toBe(170);
    expect(wrapDegrees(45)).toBe(45);
    expect(wrapDegrees(360)).toBe(0);
  });
});

describe("HeadFollower", () => {
  it("takes the first pose as centre and does not move", () => {
    const follower = new HeadFollower();
    expect(follower.step(pose(37, -12), TICK)).toEqual({ pan: 0, tilt: 0 });
    expect(hold(follower, pose(37, -12), 1)).toEqual({ pan: 0, tilt: 0 });
  });

  it("pans right when the head turns right (negative yaw)", () => {
    const follower = new HeadFollower();
    follower.step(pose(0), TICK);
    expect(follower.step(pose(-30), TICK).pan).toBeGreaterThan(0);
  });

  it("tilts up when the head looks up", () => {
    const follower = new HeadFollower();
    follower.step(pose(0, 0), TICK);
    expect(follower.step(pose(0, 20), TICK).tilt).toBeGreaterThan(0);
  });

  it("settles with the camera where the head points", () => {
    const follower = new HeadFollower();
    follower.step(pose(10, 5), TICK);
    const settled = hold(follower, pose(-20, 15), 3);

    expect(settled).toEqual({ pan: 0, tilt: 0 });
    near(follower.position.pan, 30);
    near(follower.position.tilt, 10);
  });

  it("holds still for small head jitter", () => {
    const follower = new HeadFollower();
    follower.step(pose(0), TICK);
    for (let i = 0; i < 100; i++) {
      const wobble = i % 2 === 0 ? 0.8 : -0.8;
      expect(follower.step(pose(wobble, -wobble), TICK)).toEqual({ pan: 0, tilt: 0 });
    }
  });

  it("never asks for more than full speed", () => {
    const follower = new HeadFollower();
    follower.step(pose(0), TICK);
    const fast = follower.step(pose(-170, 80), TICK);
    expect(Math.abs(fast.pan)).toBeLessThanOrEqual(100);
    expect(Math.abs(fast.tilt)).toBeLessThanOrEqual(100);
  });

  it("stops at the configured limits", () => {
    const follower = new HeadFollower({ ...DEFAULT_FOLLOWER, maxPan: 40, maxTilt: 20 });
    follower.step(pose(0), TICK);
    hold(follower, pose(-120, 70), 5);
    near(follower.position.pan, 40);
    near(follower.position.tilt, 20);
  });

  it("turns the short way across the back", () => {
    const follower = new HeadFollower();
    follower.step(pose(170), TICK);
    // 170 -> -170 is 20 degrees further left, not 340 to the right
    expect(follower.step(pose(-170), 0.1).pan).toBeLessThan(0);
  });

  it("integrates its own commands into the estimate", () => {
    const follower = new HeadFollower();
    follower.step(pose(0), TICK);
    const command = follower.step(pose(-60), 0.1);
    expect(follower.position.pan).toBeCloseTo(command.pan * GIMBAL_DEG_PER_SEC_PER_UNIT * 0.1, 6);
  });

  it("forgets everything on zero", () => {
    const follower = new HeadFollower();
    follower.step(pose(0), TICK);
    hold(follower, pose(-45), 2);
    follower.zero(pose(-45));
    expect(follower.position).toEqual({ pan: 0, tilt: 0 });
    expect(follower.step(pose(-45), TICK)).toEqual({ pan: 0, tilt: 0 });
  });
});
