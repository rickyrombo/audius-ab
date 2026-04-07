import { useEffect, useRef } from 'react'
import type { SyncedWaveforms } from '../lib/waveforms'

interface Props {
  syncedRef: React.MutableRefObject<SyncedWaveforms | null>
  isPlaying: boolean
  trackIndex: number
  accentColor?: string
  otherAccentColor?: string
  showOverlay?: boolean
}

// Map every FFT bin to a logarithmic x-position for a smooth high-res line
const DB_MIN = -90
const DB_MAX = 0
const FREQ_MIN = 20
const FREQ_MAX = 20000

const GRID_FREQS = [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const GRID_LABELS = ['30', '50', '100', '200', '500', '1k', '2k', '5k', '10k', '20k']
const GRID_DB = [0, -12, -24, -36, -48, -60, -72, -84]

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function freqToX(freq: number, w: number): number {
  const logMin = Math.log10(FREQ_MIN)
  const logMax = Math.log10(FREQ_MAX)
  return ((Math.log10(freq) - logMin) / (logMax - logMin)) * w
}

function xToFreq(x: number, w: number): number {
  const logMin = Math.log10(FREQ_MIN)
  const logMax = Math.log10(FREQ_MAX)
  return Math.pow(10, logMin + (x / w) * (logMax - logMin))
}

function dbToY(db: number, _h: number, top: number, bottom: number): number {
  const clamped = Math.max(DB_MIN, Math.min(DB_MAX, db))
  return top + ((DB_MAX - clamped) / (DB_MAX - DB_MIN)) * (bottom - top)
}

function yToDb(y: number, top: number, bottom: number): number {
  const ratio = (y - top) / (bottom - top)
  return DB_MAX - ratio * (DB_MAX - DB_MIN)
}

function freqToNote(freq: number): string {
  if (freq <= 0) return ''
  const semitones = 12 * Math.log2(freq / 440)
  const midi = Math.round(semitones) + 69
  const note = NOTE_NAMES[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 1
  const cents = Math.round((semitones - Math.round(semitones)) * 100)
  const centsStr = cents === 0 ? '' : cents > 0 ? ` +${cents}¢` : ` ${cents}¢`
  return `${note}${octave}${centsStr}`
}

function formatFreq(freq: number): string {
  if (freq >= 1000) return `${(freq / 1000).toFixed(freq >= 10000 ? 1 : 2)}kHz`
  return `${Math.round(freq)}Hz`
}

function parseHexColor(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

export default function SpectrumAnalyzer({
  syncedRef, isPlaying, trackIndex,
  accentColor = '#cc0000', otherAccentColor = '#888888',
  showOverlay = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number | null>(null)
  const showOverlayRef = useRef(false)
  showOverlayRef.current = showOverlay

  // Mouse state — tracked outside React to avoid re-renders
  const mouseRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const synced = syncedRef.current
    if (!canvas || !synced) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Primary track
    const analyser = synced.getTrackAnalyser(trackIndex)
    if (!analyser) return
    analyser.fftSize = 8192
    analyser.smoothingTimeConstant = 0.75
    const sampleRate = synced.getSampleRate()
    const bufLen = analyser.frequencyBinCount
    const dataArr = new Float32Array(bufLen)
    const binHz = sampleRate / analyser.fftSize
    const smoothed = new Float32Array(bufLen).fill(DB_MIN)

    // Other track (for overlay)
    const otherIndex = trackIndex === 0 ? 1 : 0
    const otherAnalyser = synced.getTrackAnalyser(otherIndex)
    const hasOther = !!otherAnalyser
    const otherDataArr = new Float32Array(bufLen)
    const otherSmoothed = new Float32Array(bufLen).fill(DB_MIN)
    if (hasOther) {
      otherAnalyser!.fftSize = 8192
      otherAnalyser!.smoothingTimeConstant = 0.75
    }

    // Set canvas size at device resolution
    const rect = canvas.getBoundingClientRect()
    const dpr = devicePixelRatio || 1
    const cssW = rect.width
    const cssH = rect.height
    canvas.width = cssW * dpr
    canvas.height = cssH * dpr
    ctx.scale(dpr, dpr)

    // Cache fill gradients
    const [hr, hg, hb] = parseHexColor(accentColor)
    const fillGrad = ctx.createLinearGradient(0, 10, 0, cssH - 20)
    fillGrad.addColorStop(0, `rgba(${hr},${hg},${hb},0.3)`)
    fillGrad.addColorStop(1, `rgba(${hr},${hg},${hb},0.02)`)

    const [ohr, ohg, ohb] = parseHexColor(otherAccentColor)
    const otherFillGrad = ctx.createLinearGradient(0, 10, 0, cssH - 20)
    otherFillGrad.addColorStop(0, `rgba(${ohr},${ohg},${ohb},0.2)`)
    otherFillGrad.addColorStop(1, `rgba(${ohr},${ohg},${ohb},0.01)`)

    // Mouse tracking
    function onMouseMove(e: MouseEvent) {
      const r = canvas!.getBoundingClientRect()
      mouseRef.current = { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    function onMouseLeave() {
      mouseRef.current = null
    }
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseleave', onMouseLeave)

    function drawSpectrum(
      data: Float32Array, smooth: Float32Array,
      strokeColor: string, grad: CanvasGradient,
      lineAlpha: number,
    ) {
      const w = cssW
      const h = cssH
      const padTop = 10
      const padBottom = 20

      ctx!.beginPath()
      let started = false
      for (let bin = 1; bin < bufLen; bin++) {
        const freq = bin * binHz
        if (freq < FREQ_MIN || freq > FREQ_MAX) continue

        const rawDb = isFinite(data[bin]) ? data[bin] : DB_MIN
        smooth[bin] += (rawDb - smooth[bin]) * 0.4

        const x = freqToX(freq, w)
        const y = dbToY(smooth[bin], h, padTop, h - padBottom)

        if (!started) {
          ctx!.moveTo(x, y)
          started = true
        } else {
          ctx!.lineTo(x, y)
        }
      }

      ctx!.globalAlpha = lineAlpha
      ctx!.strokeStyle = strokeColor
      ctx!.lineWidth = 1.5
      ctx!.lineJoin = 'round'
      ctx!.stroke()

      if (started) {
        ctx!.lineTo(freqToX(FREQ_MAX, w), h - padBottom)
        ctx!.lineTo(freqToX(FREQ_MIN, w), h - padBottom)
        ctx!.closePath()
        ctx!.fillStyle = grad
        ctx!.fill()
      }
      ctx!.globalAlpha = 1
    }

    function draw() {
      const w = cssW
      const h = cssH
      const padTop = 10
      const padBottom = 20

      ctx!.clearRect(0, 0, canvas!.width, canvas!.height)

      // Grid lines — frequency
      ctx!.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx!.lineWidth = 1
      ctx!.fillStyle = '#555'
      ctx!.font = '9px sans-serif'
      ctx!.textAlign = 'center'
      for (let i = 0; i < GRID_FREQS.length; i++) {
        const x = freqToX(GRID_FREQS[i], w)
        ctx!.beginPath()
        ctx!.moveTo(x, padTop)
        ctx!.lineTo(x, h - padBottom)
        ctx!.stroke()
        ctx!.fillText(GRID_LABELS[i], x, h - 4)
      }

      // Grid lines — dB
      ctx!.textAlign = 'right'
      for (const db of GRID_DB) {
        const y = dbToY(db, h, padTop, h - padBottom)
        ctx!.beginPath()
        ctx!.moveTo(0, y)
        ctx!.lineTo(w, y)
        ctx!.stroke()
        ctx!.fillText(`${db}`, 28, y + 3)
      }

      // Draw overlay first (behind)
      if (showOverlayRef.current && hasOther) {
        otherAnalyser!.getFloatFrequencyData(otherDataArr)
        drawSpectrum(otherDataArr, otherSmoothed, otherAccentColor, otherFillGrad, 0.5)
      }

      // Draw primary on top
      analyser.getFloatFrequencyData(dataArr)
      drawSpectrum(dataArr, smoothed, accentColor, fillGrad, 1)

      // ── Crosshair on hover ──
      const mouse = mouseRef.current
      if (mouse && mouse.x >= 0 && mouse.x <= w && mouse.y >= padTop && mouse.y <= h - padBottom) {
        const mx = mouse.x
        const my = mouse.y

        // Crosshair lines
        ctx!.strokeStyle = 'rgba(255, 255, 255, 0.15)'
        ctx!.lineWidth = 1
        ctx!.setLineDash([4, 4])
        ctx!.beginPath()
        ctx!.moveTo(mx, padTop)
        ctx!.lineTo(mx, h - padBottom)
        ctx!.stroke()
        ctx!.beginPath()
        ctx!.moveTo(0, my)
        ctx!.lineTo(w, my)
        ctx!.stroke()
        ctx!.setLineDash([])

        // Compute values
        const freq = xToFreq(mx, w)
        const db = yToDb(my, padTop, h - padBottom)
        const note = freqToNote(freq)
        const freqLabel = formatFreq(freq)
        const dbLabel = `${db.toFixed(1)} dB`

        // Draw labels with background pills
        ctx!.font = 'bold 10px sans-serif'

        // Frequency + note label (top of vertical line)
        const topLabel = `${freqLabel}  ${note}`
        const topMetrics = ctx!.measureText(topLabel)
        const topLabelW = topMetrics.width + 8
        const topLabelH = 14
        const topLabelX = Math.min(Math.max(mx - topLabelW / 2, 2), w - topLabelW - 2)
        const topLabelY = padTop + 2

        ctx!.fillStyle = 'rgba(0, 0, 0, 0.75)'
        ctx!.beginPath()
        ctx!.roundRect(topLabelX, topLabelY, topLabelW, topLabelH, 3)
        ctx!.fill()
        ctx!.fillStyle = '#ddd'
        ctx!.textAlign = 'center'
        ctx!.fillText(topLabel, topLabelX + topLabelW / 2, topLabelY + topLabelH - 3)

        // dB label (right of horizontal line)
        const dbMetrics = ctx!.measureText(dbLabel)
        const dbLabelW = dbMetrics.width + 8
        const dbLabelH = 14
        const dbLabelX = w - dbLabelW - 2
        const dbLabelY = Math.min(Math.max(my - dbLabelH / 2, padTop), h - padBottom - dbLabelH)

        ctx!.fillStyle = 'rgba(0, 0, 0, 0.75)'
        ctx!.beginPath()
        ctx!.roundRect(dbLabelX, dbLabelY, dbLabelW, dbLabelH, 3)
        ctx!.fill()
        ctx!.fillStyle = '#ddd'
        ctx!.textAlign = 'center'
        ctx!.fillText(dbLabel, dbLabelX + dbLabelW / 2, dbLabelY + dbLabelH - 3)
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [syncedRef, isPlaying, trackIndex, accentColor, otherAccentColor, showOverlay])

  return (
    <div className="analyzer-panel">
      <div className="analyzer-label">Spectrum</div>
      <canvas ref={canvasRef} className="analyzer-canvas spectrum-canvas" />
    </div>
  )
}
