import { GIMBAL_RANGE } from "~/utils/gimbal";
import { isTauri } from "~/utils/saveFile";

/**
 * A head orientation in degrees, as CoreMotion reports it for headphones:
 * positive yaw is turning left, positive pitch is looking up.
 */
export interface HeadPose {
  yaw: number;
  pitch: number;
  roll: number;
}

export interface HeadTrackingStatus {
  supported: boolean;
  authorization: "notDetermined" | "restricted" | "denied" | "authorized" | "unknown";
  active: boolean;
}

/**
 * How fast the gimbal turns per unit of joystick, in degrees per second.
 * Measured from the preview at the default (fast) gimbal speed: a pan of 60
 * moved the picture at about 34°/s. The camera reports no angle back, so this
 * is what the follower integrates to know where the gimbal points.
 */
export const GIMBAL_DEG_PER_SEC_PER_UNIT = 34 / 60;

export interface FollowerOptions {
  /** Camera degrees per degree of head movement. */
  gain: number;
  /** Furthest the camera is asked to pan, either way, in degrees. */
  maxPan: number;
  /** Furthest the camera is asked to tilt, either way, in degrees. */
  maxTilt: number;
  /** Errors smaller than this, in degrees, are left alone so the shot holds still. */
  deadband: number;
  /** Seconds the follower takes to close most of an error: lower is snappier. */
  response: number;
  /** Time constant of the low-pass on the head, in seconds; takes out tremor. */
  smoothing: number;
}

export const DEFAULT_FOLLOWER: FollowerOptions = {
  gain: 1,
  maxPan: 150,
  maxTilt: 60,
  deadband: 1.5,
  response: 0.25,
  smoothing: 0.08,
};

/** -180..180, so turning past behind you does not become a full spin the other way. */
export const wrapDegrees = (degrees: number): number =>
  ((((degrees + 180) % 360) + 360) % 360) - 180;

const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

/**
 * Turns head poses into gimbal joystick vectors.
 *
 * The camera only takes speeds, and never says where it points, so the
 * follower keeps its own estimate: every command it issues, times the
 * measured degrees per second per unit, times the time it ran. It then asks
 * for whatever speed closes the gap between that estimate and where the head
 * says the camera should be. Recentering both the head reference and the
 * gimbal (zero) is what brings the estimate back to the truth.
 */
export class HeadFollower {
  private reference: HeadPose | null = null;
  private target = { pan: 0, tilt: 0 };
  private estimate = { pan: 0, tilt: 0 };

  constructor(private readonly options: FollowerOptions = DEFAULT_FOLLOWER) {}

  /** The head as it is now means "camera at centre". */
  zero(pose: HeadPose | null = null) {
    this.reference = pose;
    this.target = { pan: 0, tilt: 0 };
    this.estimate = { pan: 0, tilt: 0 };
  }

  /** Where the follower believes the gimbal points, in degrees from centre. */
  get position(): { pan: number; tilt: number } {
    return { ...this.estimate };
  }

  /** One sample in, one joystick vector out. `seconds` is the time since the last sample. */
  step(pose: HeadPose, seconds: number): { pan: number; tilt: number } {
    if (!this.reference) {
      this.zero(pose);
      return { pan: 0, tilt: 0 };
    }
    const { gain, maxPan, maxTilt, smoothing } = this.options;
    const dt = Math.max(0, Math.min(seconds, 0.25));

    // Turning left is positive yaw, but positive pan is to the right
    const wantPan = clamp(-wrapDegrees(pose.yaw - this.reference.yaw) * gain, maxPan);
    const wantTilt = clamp(wrapDegrees(pose.pitch - this.reference.pitch) * gain, maxTilt);
    const blend = smoothing > 0 ? 1 - Math.exp(-dt / smoothing) : 1;
    this.target.pan += (wantPan - this.target.pan) * blend;
    this.target.tilt += (wantTilt - this.target.tilt) * blend;

    const pan = this.command(this.target.pan - this.estimate.pan);
    const tilt = this.command(this.target.tilt - this.estimate.tilt);
    this.estimate.pan += pan * GIMBAL_DEG_PER_SEC_PER_UNIT * dt;
    this.estimate.tilt += tilt * GIMBAL_DEG_PER_SEC_PER_UNIT * dt;
    return { pan, tilt };
  }

  private command(error: number): number {
    if (Math.abs(error) < this.options.deadband) return 0;
    const speed = error / (GIMBAL_DEG_PER_SEC_PER_UNIT * this.options.response);
    return Math.round(clamp(speed, GIMBAL_RANGE));
  }
}

const NOT_SUPPORTED: HeadTrackingStatus = {
  supported: false,
  authorization: "unknown",
  active: false,
};

async function invoke<T>(command: string): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(command);
}

/** The desktop side of head tracking. Outside the desktop app it reports unsupported. */
export const headTrackingClient = {
  async status(): Promise<HeadTrackingStatus> {
    return isTauri() ? invoke<HeadTrackingStatus>("luna_headtrack_status") : NOT_SUPPORTED;
  },

  async start(): Promise<HeadTrackingStatus> {
    return invoke<HeadTrackingStatus>("luna_headtrack_start");
  },

  async stop(): Promise<void> {
    if (isTauri()) await invoke("luna_headtrack_stop");
  },

  async onPose(handler: (pose: HeadPose) => void): Promise<() => void> {
    if (!isTauri()) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    return listen<HeadPose>("headtrack://pose", (event) => handler(event.payload));
  },
};
