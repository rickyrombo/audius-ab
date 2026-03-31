import { useEffect, useRef, useState } from 'react'
import type { SyncedWaveforms } from '../lib/waveforms'

interface Props {
  syncedRef: React.MutableRefObject<SyncedWaveforms | null>
  isPlaying: boolean
}

// EBU R128 short-term integration = 3 seconds
const SHORT_TERM_WINDOW_S = 3
const HISTORY_DURATION_S = 30
const HISTORY_INTERVAL_MS = 50

type GraphMetric = 'peak' | 'rms' | 'momentary' | 'short' | 'integrated'

const METRIC_LABELS: Record<GraphMetric, string> = {
  peak: 'Peak',
  rms: 'RMS',
  momentary: 'Momentary LUFS',
  short: 'Short-term LUFS',
  integrated: 'Integrated LUFS',
}

export default function VolumeIndicator({ syncedRef, isPlaying }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number | null>(null)
  const [graphMetric, setGraphMetric] = useState<GraphMetric>('short')
  const graphMetricRef = useRef<GraphMetric>(graphMetric)
  graphMetricRef.current = graphMetric

  useEffect(() => {
    const canvas = canvasRef.current
    const synced = syncedRef.current
    if (!canvas || !synced) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const analyser = synced.getAnalyser()
    const bufLen = analyser.frequencyBinCount
    const timeDomain = new Float32Array(bufLen)

    // Peak hold
    let peakHold = -Infinity
    let peakHoldTime = 0
    const PEAK_HOLD_MS = 1500

    // Smoothing for meters
    let smoothPeakDb = -60
    let smoothRmsDb = -60
    let smoothMomentaryLufs = -60
    let smoothShortTermLufs = -60
    let smoothIntegratedLufs = -60

    // Ring buffer for short-term LUFS integration
    const msRingBuffer: { ms: number; t: number }[] = []

    // Integrated LUFS: running sum of all mean-square values
    let integratedSum = 0
    let integratedCount = 0

    // History buffers for each metric
    const maxHistoryPoints = Math.ceil(HISTORY_DURATION_S * (1000 / HISTORY_INTERVAL_MS))
    const history: Record<GraphMetric, number[]> = {
      peak: [],
      rms: [],
      momentary: [],
      short: [],
      integrated: [],
    }
    let lastHistoryPush = 0

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

    function draw() {
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height)

      analyser.getFloatTimeDomainData(timeDomain)

      const now = performance.now()

      // Compute peak and RMS (momentary)
      let peak = 0
      let sumSq = 0
      for (let i = 0; i < bufLen; i++) {
        const abs = Math.abs(timeDomain[i])
        if (abs > peak) peak = abs
        sumSq += timeDomain[i] * timeDomain[i]
      }
      const meanSquare = sumSq / bufLen
      const rms = Math.sqrt(meanSquare)

      const peakDb = Math.max(-60, dbFromLinear(peak))
      const rmsDb = Math.max(-60, dbFromLinear(rms))
      const momentaryLufs = Math.max(-60, dbFromLinear(rms) - 0.691)

      // Short-term LUFS: integrate mean-square over 3s window
      msRingBuffer.push({ ms: meanSquare, t: now })
      const windowStart = now - SHORT_TERM_WINDOW_S * 1000
      while (msRingBuffer.length > 0 && msRingBuffer[0].t < windowStart) {
        msRingBuffer.shift()
      }
      let stSum = 0
      for (let i = 0; i < msRingBuffer.length; i++) {
        stSum += msRingBuffer[i].ms
      }
      const stMeanSquare = msRingBuffer.length > 0 ? stSum / msRingBuffer.length : 0
      const shortTermLufs = Math.max(-60, dbFromLinear(Math.sqrt(stMeanSquare)) - 0.691)

      // Integrated LUFS: running average over entire playback
      integratedSum += meanSquare
      integratedCount++
      const intMeanSquare = integratedSum / integratedCount
      const integratedLufs = Math.max(-60, dbFromLinear(Math.sqrt(intMeanSquare)) - 0.691)

      // Smooth meter values
      smoothPeakDb += (peakDb - smoothPeakDb) * 0.4
      smoothRmsDb += (rmsDb - smoothRmsDb) * 0.2
      smoothMomentaryLufs += (momentaryLufs - smoothMomentaryLufs) * 0.25
      smoothShortTermLufs += (shortTermLufs - smoothShortTermLufs) * 0.1
      smoothIntegratedLufs += (integratedLufs - smoothIntegratedLufs) * 0.05

      // Peak hold
      if (peakDb >= peakHold) {
        peakHold = peakDb
        peakHoldTime = now
      } else if (now - peakHoldTime > PEAK_HOLD_MS) {
        peakHold += (peakDb - peakHold) * 0.05
      }

      // Push to all history buffers
      if (now - lastHistoryPush > HISTORY_INTERVAL_MS) {
        history.peak.push(smoothPeakDb)
        history.rms.push(smoothRmsDb)
        history.momentary.push(momentaryLufs)
        history.short.push(shortTermLufs)
        history.integrated.push(integratedLufs)
        for (const key of Object.keys(history) as GraphMetric[]) {
          if (history[key].length > maxHistoryPoints) history[key].shift()
        }
        lastHistoryPush = now
      }

      // ── Draw meters (left side) ──
      const meters = [
        { label: 'PEAK', value: smoothPeakDb, hold: peakHold },
        { label: 'RMS', value: smoothRmsDb, hold: null },
        { label: 'M', value: smoothMomentaryLufs, hold: null },
        { label: 'S', value: smoothShortTermLufs, hold: null },
        { label: 'I', value: smoothIntegratedLufs, hold: null },
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
          meter.value > -59 ? meter.value.toFixed(1) : '-∞',
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
      const selectedHistory = history[selectedMetric]

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
      for (const s of timeSteps) {
        if (s > HISTORY_DURATION_S) break
        const x = graphRight - (s / HISTORY_DURATION_S) * graphW
        ctx!.fillText(s === 0 ? 'now' : `-${s}s`, x, graphBottom + 12)
      }

      // Draw history line
      if (selectedHistory.length > 1) {
        const pointsPerSec = 1000 / HISTORY_INTERVAL_MS
        const totalPoints = HISTORY_DURATION_S * pointsPerSec

        ctx!.beginPath()
        let started = false
        for (let i = 0; i < selectedHistory.length; i++) {
          const age = selectedHistory.length - 1 - i
          const x = graphRight - (age / totalPoints) * graphW
          const y = dbToGraphY(selectedHistory[i])

          if (x < graphLeft) continue
          if (!started) {
            ctx!.moveTo(x, y)
            started = true
          } else {
            ctx!.lineTo(x, y)
          }
        }
        ctx!.strokeStyle = '#cc0000'
        ctx!.lineWidth = 1.5
        ctx!.lineJoin = 'round'
        ctx!.stroke()

        // Fill under
        if (started) {
          ctx!.lineTo(graphRight, graphBottom)
          ctx!.lineTo(graphRight - ((selectedHistory.length - 1) / totalPoints) * graphW, graphBottom)
          ctx!.closePath()
          const grad = ctx!.createLinearGradient(0, graphTop, 0, graphBottom)
          grad.addColorStop(0, 'rgba(204, 0, 0, 0.25)')
          grad.addColorStop(1, 'rgba(204, 0, 0, 0.02)')
          ctx!.fillStyle = grad
          ctx!.fill()
        }

        // Current value label
        const currentVal = selectedHistory[selectedHistory.length - 1]
        const unitSuffix = selectedMetric === 'peak' || selectedMetric === 'rms' ? ' dBFS' : ' LUFS'
        ctx!.fillStyle = '#cc0000'
        ctx!.font = 'bold 11px sans-serif'
        ctx!.textAlign = 'left'
        ctx!.fillText(
          currentVal > -59 ? `${currentVal.toFixed(1)}${unitSuffix}` : `-∞${unitSuffix}`,
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
  }, [syncedRef, isPlaying])

  return (
    <div className="analyzer-panel analyzer-panel-wide">
      <div className="analyzer-label">Loudness</div>
      <canvas ref={canvasRef} className="analyzer-canvas volume-canvas" />
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
  )
}
