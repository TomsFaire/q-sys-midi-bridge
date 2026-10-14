/**
 * pickup — soft takeover for absolute (non-motor) knobs.
 *
 * When a strip is remapped, the Q-SYS value and the knob's physical position
 * disagree. Writing the knob's CC straight away would make the value jump, so
 * a disarmed key ignores its knob until the knob reaches (or sweeps across)
 * the position matching the target's current value. Pure; no I/O.
 */

/** How close (in CC steps) the knob must be to the target to pick it up. */
export const THRESHOLD = 2

/**
 * Position (0..127) a knob would need to be at to write `value` given the
 * engine's scale(): the inverse of min + (cc/127)*(max-min), clamped, rounded.
 */
export function valueToCc(value: number, min: number, max: number): number {
  if (max === min) return 0
  const cc = Math.round(((value - min) / (max - min)) * 127)
  return Math.min(127, Math.max(0, cc))
}

interface Pending {
  target: number | null
  last: number | null
}

export class PickupGate {
  private pending = new Map<string, Pending>()

  /** Strip became (or may have become) out of step with its knob. `targetCc` null = target value not known yet. */
  disarm(key: string, targetCc: number | null): void {
    this.pending.set(key, { target: targetCc, last: null })
  }

  /** Update the target of a disarmed key without resetting sweep tracking. */
  setTarget(key: string, targetCc: number): void {
    const p = this.pending.get(key)
    if (p) p.target = targetCc
  }

  /** true => caller should apply this CC. */
  accept(key: string, cc: number): boolean {
    const p = this.pending.get(key)
    if (!p) return true
    const last = p.last
    p.last = cc
    if (p.target === null) return false
    const d = cc - p.target
    const crossed = last !== null && (last - p.target) * d <= 0
    if (Math.abs(d) <= THRESHOLD || crossed) {
      this.pending.delete(key)
      return true
    }
    return false
  }

  isArmed(key: string): boolean {
    return !this.pending.has(key)
  }

  /** Target position of a disarmed key, or null. */
  pendingTarget(key: string): number | null {
    return this.pending.get(key)?.target ?? null
  }
}
