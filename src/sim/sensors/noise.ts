/**
 * Sensor noise parameters. Spec §10.
 *
 * Every noise parameter lives in one table so S2's `noiseMultiplier` can sweep
 * all of them at once. `noiseMultiplier: 0` is the control condition (spec §9.7)
 * and must produce a run with no failures whatsoever — it isolates navigation,
 * allocation and reporting from perception.
 */

export const NOISE = {
  /** Spec §10: DEPTH_SIGMA 0.004 + 0.002 r^2, metres. Axial range error. */
  depthBaseSigma: 0.004,
  depthRangeSigma: 0.002,

  /** Spec §10: DEPTH_DROPOUT 1.5%. */
  depthDropout: 0.015,

  /** Spec §10: DEPTH_BUDGET 2048 points per tick. */
  depthBudget: 2048,

  /** Rare multiplicative spike outliers at glass and specular surfaces. */
  depthSpikeProbability: 0.004,
  depthSpikeFactor: 1.8,

  /** Spec §4.2: THERMAL_NETD 0.03 K. */
  thermalNetd: 0.03,

  /** Spec §4.2: 3x3 spatial blur — thermal cameras genuinely lack sharpness. */
  thermalBlurRadius: 1,

  /**
   * Spec §4.2: the emissivity error term, in kelvin, applied as a constant
   * per-agent offset.
   *
   * Physically it stands for "a 0.90-emissivity target read against a 0.95 surface
   * reads several kelvin low", which is a real and dominant thermal-camera error.
   *
   * **Sized deliberately to the anomaly set.** At +/-4 K it was *smaller* than every
   * authored thermal anomaly (6.5-14 K), so the naive absolute-threshold detector
   * still found them all with zero false positives and the §4.2 claim it exists to
   * support was untestable. At +/-8 K the offset is comparable to the two smaller
   * cold anomalies, which is where uncalibrated thresholds actually fail: an agent
   * whose offset is +6 K reads a -6.5 K missing-insulation patch as room
   * temperature, while a detector that estimates its own baseline cancels the
   * offset exactly and sees it.
   *
   * So this number is a *tuning surface for the experiment*, not a physical
   * constant, and it should be treated as one. Spec §4.2 says the same thing.
   */
  emissivityErrorK: 8.0,

  /** Spec §4.3: HUMIDITY_TAU 4.0 s first-order lag. */
  humidityTau: 4.0,

  /** Per-agent calibration offset on humidity, unknown to the agent. */
  humidityBias: 0.04,

  /** Imu white noise. */
  gyroWhiteNoise: 0.002,
  accelWhiteNoise: 0.02,

  /**
   * Spec §4.5.1: initial bias magnitude before calibration, and the bias random
   * walk that makes calibration decay rather than be permanent.
   */
  gyroInitialBias: 0.02,
  gyroBiasWalk: 0.0004,
  accelInitialBias: 0.15,
  accelBiasWalk: 0.004,
} as const

/** Residual bias fraction at calibration, decaying to `driftedResidual` (spec §4.5.1). */
export const CAL = {
  calibratedResidual: 0.15,
  driftedResidual: 0.6,
} as const