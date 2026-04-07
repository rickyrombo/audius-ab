/**
 * RGB waveform analysis matching Mixxx's algorithm:
 *   - 4th-order Butterworth IIR filters (LP/BP/HP) at 600 Hz / 4000 Hz
 *   - Peak detection per stride
 *   - Max-component normalization to preserve hue
 *
 *   Red = Low (0–600 Hz), Green = Mid (600–4000 Hz), Blue = High (4000+ Hz)
 */

export interface WaveformBar {
  /** Peak amplitude 0..1 */
  amplitude: number
  /** RGB color derived from frequency content, each 0..255 */
  r: number
  g: number
  b: number
}

export interface WaveformColorData {
  bars: WaveformBar[]
  /** Samples per stride (hop) */
  hopSize: number
  sampleRate: number
  duration: number
}

// Crossover frequencies (Mixxx standard)
const LOW_CUTOFF = 600
const HIGH_CUTOFF = 4000

// ── Biquad IIR filter ──────────────────────────────────────────────────────

interface BiquadCoeffs {
  b0: number; b1: number; b2: number
  a1: number; a2: number
}

/** State for one biquad section (Direct Form II Transposed) */
interface BiquadState { z1: number; z2: number }

function makeBiquadState(): BiquadState { return { z1: 0, z2: 0 } }

function biquadProcess(c: BiquadCoeffs, s: BiquadState, x: number): number {
  const y = c.b0 * x + s.z1
  s.z1 = c.b1 * x - c.a1 * y + s.z2
  s.z2 = c.b2 * x - c.a2 * y
  return y
}

/**
 * Compute biquad coefficients for lowpass/highpass Butterworth.
 * For 4th-order, cascade two sections with Q values 0.5412 and 1.3066.
 */
function butterworthLowpass(freq: number, sampleRate: number, Q: number): BiquadCoeffs {
  const w0 = 2 * Math.PI * freq / sampleRate
  const alpha = Math.sin(w0) / (2 * Q)
  const cosw0 = Math.cos(w0)
  const a0 = 1 + alpha
  return {
    b0: ((1 - cosw0) / 2) / a0,
    b1: (1 - cosw0) / a0,
    b2: ((1 - cosw0) / 2) / a0,
    a1: (-2 * cosw0) / a0,
    a2: (1 - alpha) / a0,
  }
}

function butterworthHighpass(freq: number, sampleRate: number, Q: number): BiquadCoeffs {
  const w0 = 2 * Math.PI * freq / sampleRate
  const alpha = Math.sin(w0) / (2 * Q)
  const cosw0 = Math.cos(w0)
  const a0 = 1 + alpha
  return {
    b0: ((1 + cosw0) / 2) / a0,
    b1: (-(1 + cosw0)) / a0,
    b2: ((1 + cosw0) / 2) / a0,
    a1: (-2 * cosw0) / a0,
    a2: (1 - alpha) / a0,
  }
}

// 4th-order Butterworth Q values (two cascaded biquad sections)
const Q1 = 0.54119610
const Q2 = 1.30656296

/** 4th-order Butterworth filter: two cascaded biquad sections */
interface Filter4 {
  c1: BiquadCoeffs; s1: BiquadState
  c2: BiquadCoeffs; s2: BiquadState
}

function makeLP4(freq: number, sr: number): Filter4 {
  return {
    c1: butterworthLowpass(freq, sr, Q1), s1: makeBiquadState(),
    c2: butterworthLowpass(freq, sr, Q2), s2: makeBiquadState(),
  }
}

function makeHP4(freq: number, sr: number): Filter4 {
  return {
    c1: butterworthHighpass(freq, sr, Q1), s1: makeBiquadState(),
    c2: butterworthHighpass(freq, sr, Q2), s2: makeBiquadState(),
  }
}

function filter4Process(f: Filter4, x: number): number {
  return biquadProcess(f.c2, f.s2, biquadProcess(f.c1, f.s1, x))
}

// ── Analysis ────────────────────────────────────────────────────────────────

/**
 * Analyze an AudioBuffer using Mixxx-style IIR filtering + peak detection.
 * hopSize = 100 gives ~441 bars/sec at 44.1kHz (matches Mixxx default).
 */
export function analyzeWaveformColors(
  buffer: AudioBuffer,
  hopSize = 64,
): WaveformColorData {
  const sampleRate = buffer.sampleRate
  const numChannels = buffer.numberOfChannels
  const totalSamples = buffer.length
  const numStrides = Math.floor(totalSamples / hopSize)

  // Grab channel data
  const channels: Float32Array[] = []
  for (let c = 0; c < numChannels; c++) {
    channels.push(buffer.getChannelData(c))
  }

  // Create 4th-order filters: LP at 600Hz, HP at 4kHz, BP = LP(4k) then HP(600)
  const lpLow = makeLP4(LOW_CUTOFF, sampleRate)
  const hpHigh = makeHP4(HIGH_CUTOFF, sampleRate)
  const bpLow = makeLP4(HIGH_CUTOFF, sampleRate)  // LP stage of bandpass
  const bpHigh = makeHP4(LOW_CUTOFF, sampleRate)   // HP stage of bandpass

  // Raw peak arrays per stride
  const peakAll = new Float64Array(numStrides)
  const peakLow = new Float64Array(numStrides)
  const peakMid = new Float64Array(numStrides)
  const peakHigh = new Float64Array(numStrides)

  // Process sample-by-sample through filters, accumulate peaks per stride
  let strideIdx = 0
  let stridePos = 0
  let curAll = 0, curLow = 0, curMid = 0, curHigh = 0

  for (let i = 0; i < totalSamples; i++) {
    // Mix to mono
    let sample = 0
    for (let c = 0; c < numChannels; c++) {
      sample += channels[c][i]
    }
    sample /= numChannels

    // Filter
    const lo = filter4Process(lpLow, sample)
    const hi = filter4Process(hpHigh, sample)
    const mid = filter4Process(bpHigh, filter4Process(bpLow, sample))

    // Track peaks within this stride
    const absAll = Math.abs(sample)
    const absLo = Math.abs(lo)
    const absMid = Math.abs(mid)
    const absHi = Math.abs(hi)
    if (absAll > curAll) curAll = absAll
    if (absLo > curLow) curLow = absLo
    if (absMid > curMid) curMid = absMid
    if (absHi > curHigh) curHigh = absHi

    stridePos++
    if (stridePos >= hopSize) {
      if (strideIdx < numStrides) {
        peakAll[strideIdx] = curAll
        peakLow[strideIdx] = curLow
        peakMid[strideIdx] = curMid
        peakHigh[strideIdx] = curHigh
      }
      strideIdx++
      stridePos = 0
      curAll = 0; curLow = 0; curMid = 0; curHigh = 0
    }
  }

  // Find global max for amplitude normalization
  let maxAll = 0
  for (let i = 0; i < numStrides; i++) {
    if (peakAll[i] > maxAll) maxAll = peakAll[i]
  }

  // Build bars with Mixxx-style max-component normalization
  const bars: WaveformBar[] = new Array(numStrides)
  for (let i = 0; i < numStrides; i++) {
    const lo = peakLow[i]
    const mid = peakMid[i]
    const hi = peakHigh[i]

    // Max-component normalization: brightest channel → 255, preserving hue
    const maxComp = Math.max(lo, mid, hi)
    let r = 0, g = 0, b = 0
    if (maxComp > 0) {
      r = Math.round((lo / maxComp) * 255)
      g = Math.round((mid / maxComp) * 255)
      b = Math.round((hi / maxComp) * 255)
    }

    bars[i] = {
      amplitude: maxAll > 0 ? peakAll[i] / maxAll : 0,
      r, g, b,
    }
  }

  return {
    bars,
    hopSize,
    sampleRate,
    duration: buffer.duration,
  }
}

// ── BPM Detection ──────────────────────────────────────────────────────────

const BPM_MIN = 60
const BPM_MAX = 200

/**
 * Detect BPM from an AudioBuffer.
 * Simple autocorrelation on full-spectrum onset with harmonic verification.
 */
export function detectBPM(buffer: AudioBuffer): number {
  const sampleRate = buffer.sampleRate
  const numChannels = buffer.numberOfChannels
  const totalSamples = buffer.length

  // Mix to mono
  const mono = new Float32Array(totalSamples)
  for (let c = 0; c < numChannels; c++) {
    const ch = buffer.getChannelData(c)
    for (let i = 0; i < totalSamples; i++) mono[i] += ch[i]
  }
  if (numChannels > 1) {
    for (let i = 0; i < totalSamples; i++) mono[i] /= numChannels
  }

  // Energy envelope with hop=512
  const hop = 512
  const odfRate = sampleRate / hop
  const numFrames = Math.floor(totalSamples / hop)
  if (numFrames < 2) return 120

  const energy = new Float64Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    const start = f * hop
    let sum = 0
    for (let i = 0; i < hop && start + i < totalSamples; i++) {
      sum += mono[start + i] * mono[start + i]
    }
    energy[f] = sum
  }

  // Onset: half-wave rectified difference
  const onset = new Float64Array(numFrames)
  for (let i = 1; i < numFrames; i++) {
    onset[i] = Math.max(0, energy[i] - energy[i - 1])
  }

  // Autocorrelation over BPM range
  const minLag = Math.round((60 / BPM_MAX) * odfRate)
  const maxLag = Math.round((60 / BPM_MIN) * odfRate)

  const acf = new Float64Array(maxLag + 1)
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    const n = numFrames - lag
    for (let i = 0; i < n; i++) {
      sum += onset[i] * onset[i + lag]
    }
    acf[lag] = sum / n
  }

  // Find local peaks in ACF (must be higher than both neighbors)
  const peaks: { lag: number; score: number }[] = []
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (acf[lag] > acf[lag - 1] && acf[lag] > acf[lag + 1]) {
      peaks.push({ lag, score: acf[lag] })
    }
  }
  peaks.sort((a, b) => b.score - a.score)

  if (peaks.length === 0) return 120

  // Score each peak by checking if its harmonics (lag*2, lag*3) and
  // sub-harmonics (lag/2) also have strong ACF values
  const peakScores: { bpm: number; score: number }[] = []
  for (const peak of peaks.slice(0, 20)) {
    let harmonicScore = peak.score

    // Check 2nd harmonic (lag * 2 = half BPM)
    const lag2 = peak.lag * 2
    if (lag2 <= maxLag) {
      // Find best ACF near lag2 (±2)
      let best2 = 0
      for (let d = -2; d <= 2; d++) {
        const idx = lag2 + d
        if (idx >= minLag && idx <= maxLag && acf[idx] > best2) best2 = acf[idx]
      }
      harmonicScore += best2 * 0.5
    }

    // Check sub-harmonic (lag / 2 = double BPM)
    const lagHalf = Math.round(peak.lag / 2)
    if (lagHalf >= minLag) {
      let bestH = 0
      for (let d = -2; d <= 2; d++) {
        const idx = lagHalf + d
        if (idx >= minLag && idx <= maxLag && acf[idx] > bestH) bestH = acf[idx]
      }
      harmonicScore += bestH * 0.5
    }

    // Check 3rd harmonic (lag * 3)
    const lag3 = peak.lag * 3
    if (lag3 <= maxLag) {
      let best3 = 0
      for (let d = -2; d <= 2; d++) {
        const idx = lag3 + d
        if (idx >= minLag && idx <= maxLag && acf[idx] > best3) best3 = acf[idx]
      }
      harmonicScore += best3 * 0.3
    }

    const bpm = (odfRate * 60) / peak.lag
    peakScores.push({ bpm: Math.round(bpm * 10) / 10, score: harmonicScore })
  }

  peakScores.sort((a, b) => b.score - a.score)
  console.log('[BPM candidates]', peakScores.slice(0, 10).map(s => `${s.bpm}: ${s.score.toFixed(2)}`).join(', '))

  let bestBpm = peakScores[0]?.bpm ?? 120
  if (!isFinite(bestBpm)) return 120

  // Fold into 90-180 range
  while (bestBpm < 90) bestBpm *= 2
  while (bestBpm > 180) bestBpm /= 2

  // Snap to nearest 0.5
  bestBpm = Math.round(bestBpm * 2) / 2

  return bestBpm
}

