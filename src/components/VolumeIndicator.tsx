import { useEffect, useRef, useState } from 'react'
import type { SyncedWaveforms } from '../lib/waveforms'
import type { LoudnessStats } from '../lib/waveformAnalysis'

export type GraphMetric = 'peak' | 'rms' | 'momentary' | 'short' | 'integrated'

interface Props {
  syncedRef: React.MutableRefObject<SyncedWaveforms | null>
  isPlaying: boolean
  trackIndex: number
  accentColor?: string
  otherAccentColor?: string
  showOverlay?: boolean
  loudnessStats?: LoudnessStats | null
  graphMetric?: GraphMetric
  onGraphMetricChange?: (metric: GraphMetric) => void
}

// ITU-R BS.1770 / EBU R128 constants
const MOMENTARY_WINDOW_MS = 400
const SHORT_TERM_WINDOW_S = 3
const ABSOLUTE_GATE_LUFS = -70
const RELATIVE_GATE_OFFSET = -10 // dB below ungated mean

const HISTORY_DURATION_S = 30
const HISTORY_INTERVAL_MS = 50

const METRIC_LABELS: Record<GraphMetric, string> = {
  peak: 'Peak',
  rms: 'RMS',
  momentary: 'Momentary LUFS',
  short: 'Short-term LUFS',
  integrated: 'Integrated LUFS',
}

function parseHexColor(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

// Mean-square of a Float32Array buffer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function meanSquare(buf: Float32Array<any>, len: number): number {
  let sum = 0
  for (let i = 0; i < len; i++) sum += buf[i] * buf[i]
  return sum / len
}

function lufsFromMeanSquare(ms: number): number {
  // LUFS = -0.691 + 10 * log10(mean_square)
  return ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity
}

// State for one track's loudness processing
interface TrackLoudnessState {
  // Raw analyser (for peak/RMS dBFS)
  analyser: AnalyserNode
  timeDomain: Float32Array<ArrayBuffer>
  // K-weighted analyser (for LUFS)
  kAnalyser: AnalyserNode
  kTimeDomain: Float32Array<ArrayBuffer>
  bufLen: number

  // 400ms block ring buffer for momentary/short-term
  // Each entry stores the mean-square of one 400ms block (K-weighted)
  blockMs: Float64Array
  blockTimestamps: Float64Array
  blockHead: number
  blockCount: number
  // Accumulator for building current 400ms block
  blockAccumMs: number
  blockAccumFrames: number
  lastBlockTime: number

  // Integrated LUFS: all 400ms blocks that pass absolute gate
  integratedBlocks: Float64Array // store all block mean-squares
  integratedBlockCount: number

  // Smoothed display values
  smoothPeakDb: number
  smoothRmsDb: number
  smoothMomentaryLufs: number
  smoothShortTermLufs: number
  smoothIntegratedLufs: number

  // Peak hold
  peakHold: number
  peakHoldTime: number

  // History ring buffers
  historyBufs: Record<GraphMetric, Float32Array>
  historyLen: number
  historyHead: number
}

const PEAK_HOLD_MS = 1500
const MAX_BLOCKS = Math.ceil((HISTORY_DURATION_S + 10) * (1000 / MOMENTARY_WINDOW_MS)) // ~100 blocks
const MAX_INTEGRATED_BLOCKS = 10000 // enough for ~66 minutes

export default function VolumeIndicator({
  syncedRef, isPlaying, trackIndex,
  accentColor = '#cc0000', otherAccentColor = '#888888',
  showOverlay = false,
  loudnessStats,
  graphMetric: controlledMetric, onGraphMetricChange,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number | null>(null)
  const [uncontrolledMetric, setUncontrolledMetric] = useState<GraphMetric>('short')
  const graphMetric = controlledMetric ?? uncontrolledMetric
  const setGraphMetric = (m: GraphMetric) => { onGraphMetricChange ? onGraphMetricChange(m) : setUncontrolledMetric(m) }
  const graphMetricRef = useRef<GraphMetric>(graphMetric)
  graphMetricRef.current = graphMetric
  const showOverlayRef = useRef(false)
  showOverlayRef.current = showOverlay
  const trackIndexRef = useRef(trackIndex)
  trackIndexRef.current = trackIndex
  const accentColorRef = useRef(accentColor)
  accentColorRef.current = accentColor
  const otherAccentColorRef = useRef(otherAccentColor)
  otherAccentColorRef.current = otherAccentColor

  // Persistent track states that survive prop changes
  const trackStatesRef = useRef<(TrackLoudnessState | null)[]>([null, null])
  const lastSyncedRef = useRef<SyncedWaveforms | null>(null)
  const lastHistoryPushRef = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    const synced = syncedRef.current
    if (!canvas || !synced) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Reset track states when the synced instance changes (new audio loaded)
    if (synced !== lastSyncedRef.current) {
      trackStatesRef.current = [null, null]
      lastSyncedRef.current = synced
    }

    const sampleRate = synced.getSampleRate()
    const maxHistoryPoints = Math.ceil(HISTORY_DURATION_S * (1000 / HISTORY_INTERVAL_MS))

    function createTrackState(idx: number): TrackLoudnessState | null {
      const analyser = synced!.getTrackAnalyser(idx)
      const kAnalyser = synced!.getTrackKWeightedAnalyser(idx)
      if (!analyser || !kAnalyser) return null

      const bufLen = analyser.frequencyBinCount
      return {
        analyser,
        timeDomain: new Float32Array(bufLen),
        kAnalyser,
        kTimeDomain: new Float32Array(kAnalyser.frequencyBinCount),
        bufLen,
        blockMs: new Float64Array(MAX_BLOCKS),
        blockTimestamps: new Float64Array(MAX_BLOCKS),
        blockHead: 0,
        blockCount: 0,
        blockAccumMs: 0,
        blockAccumFrames: 0,
        lastBlockTime: 0,
        integratedBlocks: new Float64Array(MAX_INTEGRATED_BLOCKS),
        integratedBlockCount: 0,
        smoothPeakDb: -60,
        smoothRmsDb: -60,
        smoothMomentaryLufs: -60,
        smoothShortTermLufs: -60,
        smoothIntegratedLufs: -60,
        peakHold: -Infinity,
        peakHoldTime: 0,
        historyBufs: {
          peak: new Float32Array(maxHistoryPoints).fill(-60),
          rms: new Float32Array(maxHistoryPoints).fill(-60),
          momentary: new Float32Array(maxHistoryPoints).fill(-60),
          short: new Float32Array(maxHistoryPoints).fill(-60),
          integrated: new Float32Array(maxHistoryPoints).fill(-60),
        },
        historyLen: 0,
        historyHead: 0,
      }
    }

    // Initialize track states if not already created (persist across prop changes)
    for (let i = 0; i < 2; i++) {
      if (!trackStatesRef.current[i]) {
        trackStatesRef.current[i] = createTrackState(i)
      }
    }

    function dbFromLinear(val: number): number {
      return val > 0 ? 20 * Math.log10(val) : -Infinity
    }

    // Set canvas size at device resolution
    const rect = canvas.getBoundingClientRect()
    const dpr = devicePixelRatio || 1
    const cssW = rect.width
    const cssH = rect.height
    canvas.width = cssW * dpr
    canvas.height = cssH * dpr
    ctx.scale(dpr, dpr)

    // Layout constants
    const DB_MIN = -60
    const DB_MAX = 0
    const meterAreaW = 180
    const graphLeft = meterAreaW + 10
    const graphRight = cssW - 8
    const graphTop = 24
    const graphBottom = cssH - 16
    const graphW = graphRight - graphLeft
    const graphH = graphBottom - graphTop

    function dbToMeterY(db: number, top: number, bottom: number): number {
      const clamped = Math.max(DB_MIN, Math.min(DB_MAX, db))
      const ratio = (clamped - DB_MIN) / (DB_MAX - DB_MIN)
      return bottom - ratio * (bottom - top)
    }

    function dbToGraphY(db: number): number {
      const clamped = Math.max(DB_MIN, Math.min(DB_MAX, db))
      return graphTop + ((DB_MAX - clamped) / (DB_MAX - DB_MIN)) * graphH
    }

    // Gradient builder (called per-frame since colors can change via refs)
    function makeGrad(hex: string, alphaHi: number, alphaLo: number): CanvasGradient {
      const [r, g, b] = parseHexColor(hex)
      const grad = ctx!.createLinearGradient(0, graphTop, 0, graphBottom)
      grad.addColorStop(0, `rgba(${r},${g},${b},${alphaHi})`)
      grad.addColorStop(1, `rgba(${r},${g},${b},${alphaLo})`)
      return grad
    }

    // Number of analyser frames per 400ms block
    const anyState = trackStatesRef.current[0] ?? trackStatesRef.current[1]
    if (!anyState) return
    const kBufLen = anyState.kAnalyser.frequencyBinCount
    const frameDurationMs = (kBufLen / sampleRate) * 1000

    function processTrack(s: TrackLoudnessState, now: number) {
      // ── Raw peak/RMS (unweighted, for dBFS meters) ──
      s.analyser.getFloatTimeDomainData(s.timeDomain)
      let peak = 0
      let sumSq = 0
      for (let i = 0; i < s.bufLen; i++) {
        const abs = Math.abs(s.timeDomain[i])
        if (abs > peak) peak = abs
        sumSq += s.timeDomain[i] * s.timeDomain[i]
      }
      const peakDb = Math.max(-60, dbFromLinear(peak))
      const rmsDb = Math.max(-60, dbFromLinear(Math.sqrt(sumSq / s.bufLen)))

      // ── K-weighted loudness ──
      s.kAnalyser.getFloatTimeDomainData(s.kTimeDomain)
      const frameMeanSq = meanSquare(s.kTimeDomain, kBufLen)

      // Accumulate into 400ms blocks
      s.blockAccumMs += frameMeanSq
      s.blockAccumFrames++
      const blockElapsed = s.blockAccumFrames * frameDurationMs

      // Momentary LUFS = loudness of current accumulation (always available, converges to 400ms)
      const momentaryMs = s.blockAccumMs / s.blockAccumFrames
      const momentaryLufs = Math.max(-60, lufsFromMeanSquare(momentaryMs))

      // When we've accumulated 400ms, commit the block
      if (blockElapsed >= MOMENTARY_WINDOW_MS) {
        const blockMeanSq = s.blockAccumMs / s.blockAccumFrames

        // Store in ring buffer
        s.blockMs[s.blockHead] = blockMeanSq
        s.blockTimestamps[s.blockHead] = now
        s.blockHead = (s.blockHead + 1) % MAX_BLOCKS
        if (s.blockCount < MAX_BLOCKS) s.blockCount++

        // Store for integrated LUFS (only if above absolute gate)
        const blockLufs = lufsFromMeanSquare(blockMeanSq)
        if (blockLufs > ABSOLUTE_GATE_LUFS && s.integratedBlockCount < MAX_INTEGRATED_BLOCKS) {
          s.integratedBlocks[s.integratedBlockCount++] = blockMeanSq
        }

        s.blockAccumMs = 0
        s.blockAccumFrames = 0
        s.lastBlockTime = now
      }

      // Short-term LUFS: mean of 400ms blocks within last 3 seconds
      const shortWindowStart = now - SHORT_TERM_WINDOW_S * 1000
      let stSum = 0, stCount = 0
      for (let i = 0; i < s.blockCount; i++) {
        const idx = (s.blockHead - s.blockCount + i + MAX_BLOCKS) % MAX_BLOCKS
        if (s.blockTimestamps[idx] >= shortWindowStart) {
          stSum += s.blockMs[idx]
          stCount++
        }
      }
      const shortTermLufs = stCount > 0
        ? Math.max(-60, lufsFromMeanSquare(stSum / stCount))
        : -60

      // Integrated LUFS: gated mean of all 400ms blocks
      let integratedLufs = -60
      if (s.integratedBlockCount > 0) {
        // First pass: ungated mean (already past absolute gate from storage filter)
        let ungatedSum = 0
        for (let i = 0; i < s.integratedBlockCount; i++) {
          ungatedSum += s.integratedBlocks[i]
        }
        const ungatedMeanLufs = lufsFromMeanSquare(ungatedSum / s.integratedBlockCount)

        // Second pass: relative gate — only blocks above (ungatedMean - 10 dB)
        const relativeThreshold = ungatedMeanLufs + RELATIVE_GATE_OFFSET
        let gatedSum = 0, gatedCount = 0
        for (let i = 0; i < s.integratedBlockCount; i++) {
          const bLufs = lufsFromMeanSquare(s.integratedBlocks[i])
          if (bLufs > relativeThreshold) {
            gatedSum += s.integratedBlocks[i]
            gatedCount++
          }
        }
        if (gatedCount > 0) {
          integratedLufs = Math.max(-60, lufsFromMeanSquare(gatedSum / gatedCount))
        }
      }

      // Smooth display values
      s.smoothPeakDb += (peakDb - s.smoothPeakDb) * 0.4
      s.smoothRmsDb += (rmsDb - s.smoothRmsDb) * 0.2
      s.smoothMomentaryLufs += (momentaryLufs - s.smoothMomentaryLufs) * 0.25
      s.smoothShortTermLufs += (shortTermLufs - s.smoothShortTermLufs) * 0.1
      s.smoothIntegratedLufs += (integratedLufs - s.smoothIntegratedLufs) * 0.05

      // Peak hold
      if (peakDb >= s.peakHold) {
        s.peakHold = peakDb
        s.peakHoldTime = now
      } else if (now - s.peakHoldTime > PEAK_HOLD_MS) {
        s.peakHold += (peakDb - s.peakHold) * 0.05
      }

      return { momentaryLufs, shortTermLufs, integratedLufs }
    }

    function pushHistory(s: TrackLoudnessState, raw: { momentaryLufs: number; shortTermLufs: number; integratedLufs: number }) {
      s.historyBufs.peak[s.historyHead] = s.smoothPeakDb
      s.historyBufs.rms[s.historyHead] = s.smoothRmsDb
      s.historyBufs.momentary[s.historyHead] = raw.momentaryLufs
      s.historyBufs.short[s.historyHead] = raw.shortTermLufs
      s.historyBufs.integrated[s.historyHead] = raw.integratedLufs
      s.historyHead = (s.historyHead + 1) % maxHistoryPoints
      if (s.historyLen < maxHistoryPoints) s.historyLen++
    }

    function drawHistoryLine(
      buf: Float32Array, hLen: number, hHead: number,
      strokeColor: string, fillGrad: CanvasGradient,
      alpha: number,
    ) {
      if (hLen <= 1) return
      const pointsPerSec = 1000 / HISTORY_INTERVAL_MS
      const totalPoints = HISTORY_DURATION_S * pointsPerSec

      ctx!.beginPath()
      let started = false
      for (let j = 0; j < hLen; j++) {
        const idx = (hHead - hLen + j + maxHistoryPoints) % maxHistoryPoints
        const age = hLen - 1 - j
        const x = graphRight - (age / totalPoints) * graphW
        const y = dbToGraphY(buf[idx])
        if (x < graphLeft) continue
        if (!started) { ctx!.moveTo(x, y); started = true }
        else ctx!.lineTo(x, y)
      }

      ctx!.globalAlpha = alpha
      ctx!.strokeStyle = strokeColor
      ctx!.lineWidth = 1.5
      ctx!.lineJoin = 'round'
      ctx!.stroke()

      if (started) {
        ctx!.lineTo(graphRight, graphBottom)
        ctx!.lineTo(graphRight - ((hLen - 1) / totalPoints) * graphW, graphBottom)
        ctx!.closePath()
        ctx!.fillStyle = fillGrad
        ctx!.fill()
      }
      ctx!.globalAlpha = 1
    }

    function draw() {
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height)
      const now = performance.now()

      // Always process both tracks so history accumulates regardless of view
      const states = trackStatesRef.current
      const rawResults: ({ momentaryLufs: number; shortTermLufs: number; integratedLufs: number } | null)[] = [null, null]
      for (let i = 0; i < 2; i++) {
        if (states[i]) rawResults[i] = processTrack(states[i]!, now)
      }

      // Push history for all tracks
      if (now - lastHistoryPushRef.current > HISTORY_INTERVAL_MS) {
        for (let i = 0; i < 2; i++) {
          if (states[i] && rawResults[i]) pushHistory(states[i]!, rawResults[i]!)
        }
        lastHistoryPushRef.current = now
      }

      // Determine primary/other based on current trackIndex ref
      const curTrackIndex = trackIndexRef.current
      const primary = states[curTrackIndex]
      const other = states[curTrackIndex === 0 ? 1 : 0]
      if (!primary) { rafRef.current = requestAnimationFrame(draw); return }

      // ── Draw meters (left side) ──
      const s = primary
      const meters = [
        { label: 'PEAK', value: s.smoothPeakDb, hold: s.peakHold },
        { label: 'RMS', value: s.smoothRmsDb, hold: null },
        { label: 'M', value: s.smoothMomentaryLufs, hold: null },
        { label: 'S', value: s.smoothShortTermLufs, hold: null },
        { label: 'I', value: s.smoothIntegratedLufs, hold: null },
      ]

      const meterW = 22
      const meterGap = 8
      const totalMeterW = meters.length * meterW + (meters.length - 1) * meterGap
      const meterStartX = (meterAreaW - totalMeterW) / 2
      const meterTop = 24
      const meterBottom = cssH - 30

      // dB scale labels
      ctx!.fillStyle = '#555'
      ctx!.font = '8px sans-serif'
      ctx!.textAlign = 'right'
      for (let db = 0; db >= DB_MIN; db -= 12) {
        const y = dbToMeterY(db, meterTop, meterBottom)
        ctx!.fillText(`${db}`, meterStartX - 4, y + 3)
        ctx!.fillStyle = '#1e1e1e'
        ctx!.fillRect(meterStartX - 1, y, totalMeterW + 2, 1)
        ctx!.fillStyle = '#555'
      }

      // Draw each meter bar
      meters.forEach((meter, idx) => {
        const x = meterStartX + idx * (meterW + meterGap)

        ctx!.fillStyle = '#111'
        ctx!.fillRect(x, meterTop, meterW, meterBottom - meterTop)

        const valY = dbToMeterY(meter.value, meterTop, meterBottom)
        const barH = meterBottom - valY

        if (meter.value > -3) {
          ctx!.fillStyle = '#f44'
        } else if (meter.value > -12) {
          ctx!.fillStyle = '#fa0'
        } else {
          ctx!.fillStyle = '#4a4'
        }
        ctx!.fillRect(x, valY, meterW, barH)

        if (meter.hold !== null) {
          const holdY = dbToMeterY(meter.hold, meterTop, meterBottom)
          ctx!.fillStyle = meter.hold > -1 ? '#f44' : '#fff'
          ctx!.fillRect(x, holdY - 1, meterW, 2)
        }

        ctx!.strokeStyle = '#333'
        ctx!.lineWidth = 1
        ctx!.strokeRect(x, meterTop, meterW, meterBottom - meterTop)

        ctx!.fillStyle = '#888'
        ctx!.font = '8px sans-serif'
        ctx!.textAlign = 'center'
        ctx!.fillText(meter.label, x + meterW / 2, meterBottom + 11)

        ctx!.fillStyle = '#ccc'
        ctx!.font = '9px sans-serif'
        ctx!.fillText(
          meter.value > -59 ? meter.value.toFixed(1) : '-\u221E',
          x + meterW / 2,
          meterBottom + 22,
        )
      })

      ctx!.fillStyle = '#666'
      ctx!.font = '9px sans-serif'
      ctx!.textAlign = 'center'
      ctx!.fillText('dBFS', meterStartX + totalMeterW / 2, meterTop - 8)

      // ── Draw loudness-over-time graph (right side) ──
      const selectedMetric = graphMetricRef.current
      const selectedBuf = primary.historyBufs[selectedMetric]

      // Graph background
      ctx!.fillStyle = '#111'
      ctx!.fillRect(graphLeft, graphTop, graphW, graphH)

      // Grid
      ctx!.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx!.lineWidth = 1
      ctx!.fillStyle = '#444'
      ctx!.font = '8px sans-serif'
      ctx!.textAlign = 'right'
      for (let db = 0; db >= DB_MIN; db -= 12) {
        const y = dbToGraphY(db)
        ctx!.beginPath()
        ctx!.moveTo(graphLeft, y)
        ctx!.lineTo(graphRight, y)
        ctx!.stroke()
        ctx!.fillText(`${db}`, graphRight + 1, y + 3)
      }

      // Time labels along bottom
      ctx!.fillStyle = '#444'
      ctx!.textAlign = 'center'
      ctx!.font = '8px sans-serif'
      const timeSteps = [0, 5, 10, 15, 20, 25, 30]
      for (const ts of timeSteps) {
        if (ts > HISTORY_DURATION_S) break
        const x = graphRight - (ts / HISTORY_DURATION_S) * graphW
        ctx!.fillText(ts === 0 ? 'now' : `-${ts}s`, x, graphBottom + 12)
      }

      // Draw overlay history line (behind)
      const curAccent = accentColorRef.current
      const curOtherAccent = otherAccentColorRef.current
      if (showOverlayRef.current && other && other.historyLen > 1) {
        const oSelectedBuf = other.historyBufs[selectedMetric]
        drawHistoryLine(oSelectedBuf, other.historyLen, other.historyHead, curOtherAccent, makeGrad(curOtherAccent, 0.15, 0.01), 0.5)
      }

      // Draw primary history line
      if (primary.historyLen > 1) {
        drawHistoryLine(selectedBuf, primary.historyLen, primary.historyHead, curAccent, makeGrad(curAccent, 0.25, 0.02), 1)

        // Current value label
        const newestIdx = (primary.historyHead - 1 + maxHistoryPoints) % maxHistoryPoints
        const currentVal = selectedBuf[newestIdx]
        const unitSuffix = selectedMetric === 'peak' || selectedMetric === 'rms' ? ' dBFS' : ' LUFS'
        ctx!.fillStyle = curAccent
        ctx!.font = 'bold 11px sans-serif'
        ctx!.textAlign = 'left'
        ctx!.fillText(
          currentVal > -59 ? `${currentVal.toFixed(1)}${unitSuffix}` : `-\u221E${unitSuffix}`,
          graphLeft + 4,
          graphTop + 14,
        )
      }

      // Graph title
      ctx!.fillStyle = '#666'
      ctx!.font = '9px sans-serif'
      ctx!.textAlign = 'center'
      ctx!.fillText(METRIC_LABELS[selectedMetric], graphLeft + graphW / 2, graphTop - 8)

      // Graph border
      ctx!.strokeStyle = '#333'
      ctx!.lineWidth = 1
      ctx!.strokeRect(graphLeft, graphTop, graphW, graphH)

      rafRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  // trackIndex, accentColor, otherAccentColor, showOverlay are read from refs
  // so they don't tear down the effect and lose history
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncedRef, isPlaying])

  return (
    <div className="analyzer-panel analyzer-panel-wide">
      <div className="analyzer-label">Loudness</div>
      <canvas ref={canvasRef} className="analyzer-canvas volume-canvas" />
      <div className="loudness-bottom-row">
        {loudnessStats && isFinite(loudnessStats.integratedLUFS) && (
          <div className="loudness-stats">
            <span className="loudness-stat">
              <span className="loudness-stat-label">Integrated</span>
              <span className="loudness-stat-value">{loudnessStats.integratedLUFS.toFixed(1)} LUFS</span>
            </span>
            <span className="loudness-stat">
              <span className="loudness-stat-label">LRA</span>
              <span className="loudness-stat-value">{loudnessStats.lra.toFixed(1)} LU</span>
            </span>
          </div>
        )}
        <div className="loudness-metric-tabs">
          {(Object.keys(METRIC_LABELS) as GraphMetric[]).map((key) => (
            <button
              key={key}
              type="button"
              className={`loudness-metric-tab${graphMetric === key ? ' active' : ''}`}
              onClick={() => setGraphMetric(key)}
            >
              {METRIC_LABELS[key]}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
