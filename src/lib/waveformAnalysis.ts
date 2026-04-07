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

// ── Offline Integrated LUFS + LRA (ITU-R BS.1770 / EBU R128) ──────────────

export interface LoudnessStats {
  integratedLUFS: number
  lra: number  // Loudness Range in LU
}

/**
 * K-weighting filter coefficients for ITU-R BS.1770.
 * Stage 1: High-shelf boost (+4dB above ~1.5kHz)
 * Stage 2: High-pass (RLB weighting, ~38Hz)
 */
function kWeightHighShelf(sampleRate: number): BiquadCoeffs {
  const w0 = 2 * Math.PI * 1681.974 / sampleRate
  const alpha = Math.sin(w0) / (2 * 0.7071)
  const cosw0 = Math.cos(w0)
  const A = Math.pow(10, 3.999 / 40) // +4dB
  const a0 = (A + 1) - (A - 1) * cosw0 + 2 * Math.sqrt(A) * alpha
  return {
    b0: (A * ((A + 1) + (A - 1) * cosw0 + 2 * Math.sqrt(A) * alpha)) / a0,
    b1: (-2 * A * ((A - 1) + (A + 1) * cosw0)) / a0,
    b2: (A * ((A + 1) + (A - 1) * cosw0 - 2 * Math.sqrt(A) * alpha)) / a0,
    a1: (2 * ((A - 1) - (A + 1) * cosw0)) / a0,
    a2: ((A + 1) - (A - 1) * cosw0 - 2 * Math.sqrt(A) * alpha) / a0,
  }
}

function kWeightHighPass(sampleRate: number): BiquadCoeffs {
  const w0 = 2 * Math.PI * 38.135 / sampleRate
  const alpha = Math.sin(w0) / (2 * 0.5003)
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

/**
 * Compute integrated LUFS and LRA from an AudioBuffer offline.
 * Uses 400ms blocks with 75% overlap, K-weighted per ITU-R BS.1770.
 * LRA computed per EBU R128 (10th to 95th percentile of short-term loudness).
 */
export function analyzeLoudness(buffer: AudioBuffer): LoudnessStats {
  const sampleRate = buffer.sampleRate
  const numChannels = buffer.numberOfChannels
  const totalSamples = buffer.length

  // K-weight each channel
  const kWeighted: Float64Array[] = []
  for (let c = 0; c < numChannels; c++) {
    const raw = buffer.getChannelData(c)
    const shelf = kWeightHighShelf(sampleRate)
    const shelfState = makeBiquadState()
    const hp = kWeightHighPass(sampleRate)
    const hpState = makeBiquadState()
    const out = new Float64Array(totalSamples)
    for (let i = 0; i < totalSamples; i++) {
      out[i] = biquadProcess(hp, hpState, biquadProcess(shelf, shelfState, raw[i]))
    }
    kWeighted.push(out)
  }

  // 400ms block size, 100ms hop (75% overlap per BS.1770)
  const blockSamples = Math.round(sampleRate * 0.4)
  const hopSamples = Math.round(sampleRate * 0.1)
  const numBlocks = Math.floor((totalSamples - blockSamples) / hopSamples) + 1
  if (numBlocks <= 0) return { integratedLUFS: -Infinity, lra: 0 }

  // Compute mean square per block (sum across channels with equal weighting)
  const blockMs = new Float64Array(numBlocks)
  for (let b = 0; b < numBlocks; b++) {
    const start = b * hopSamples
    let sum = 0
    for (let c = 0; c < numChannels; c++) {
      const ch = kWeighted[c]
      for (let i = start; i < start + blockSamples; i++) {
        sum += ch[i] * ch[i]
      }
    }
    blockMs[b] = sum / (blockSamples * numChannels)
  }

  function lufs(ms: number): number {
    return ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity
  }

  const ABSOLUTE_GATE = -70 // LUFS

  // ── Integrated LUFS (BS.1770 gated) ──
  // Pass 1: absolute gate
  const aboveAbsolute: number[] = []
  for (let i = 0; i < numBlocks; i++) {
    if (lufs(blockMs[i]) > ABSOLUTE_GATE) aboveAbsolute.push(i)
  }
  if (aboveAbsolute.length === 0) return { integratedLUFS: -Infinity, lra: 0 }

  let ungatedSum = 0
  for (const i of aboveAbsolute) ungatedSum += blockMs[i]
  const ungatedMean = lufs(ungatedSum / aboveAbsolute.length)

  // Pass 2: relative gate (-10 LU below ungated mean)
  const relativeThreshold = ungatedMean - 10
  let gatedSum = 0, gatedCount = 0
  for (const i of aboveAbsolute) {
    if (lufs(blockMs[i]) > relativeThreshold) {
      gatedSum += blockMs[i]
      gatedCount++
    }
  }
  const integratedLUFS = gatedCount > 0 ? lufs(gatedSum / gatedCount) : -Infinity

  // ── LRA (EBU R128) ──
  // Short-term loudness: 3s window, 1-block hop over the 400ms blocks
  // Each short-term window spans 30 blocks (3s / 0.1s hop)
  const stBlocks = Math.round(3.0 / (hopSamples / sampleRate))
  const numST = Math.max(0, numBlocks - stBlocks + 1)
  const stLoudness: number[] = []
  for (let s = 0; s < numST; s++) {
    let sum = 0
    for (let b = s; b < s + stBlocks; b++) sum += blockMs[b]
    const l = lufs(sum / stBlocks)
    if (l > ABSOLUTE_GATE) stLoudness.push(l)
  }

  let lra = 0
  if (stLoudness.length >= 2) {
    // Relative gate on short-term values
    const stMean = stLoudness.reduce((a, b) => a + b, 0) / stLoudness.length
    const stRelThresh = stMean - 20 // EBU R128 uses -20 LU for LRA
    const gated = stLoudness.filter(l => l > stRelThresh).sort((a, b) => a - b)
    if (gated.length >= 2) {
      const p10 = gated[Math.floor(gated.length * 0.1)]
      const p95 = gated[Math.floor(gated.length * 0.95)]
      lra = p95 - p10
    }
  }

  return { integratedLUFS, lra }
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

