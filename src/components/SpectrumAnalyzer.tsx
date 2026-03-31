import { useEffect, useRef } from 'react'
import type { SyncedWaveforms } from '../lib/waveforms'

interface Props {
  syncedRef: React.MutableRefObject<SyncedWaveforms | null>
  isPlaying: boolean
  trackIndex: number
}

// Map every FFT bin to a logarithmic x-position for a smooth high-res line
const DB_MIN = -90
const DB_MAX = 0
const FREQ_MIN = 20
const FREQ_MAX = 20000

const GRID_FREQS = [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
const GRID_LABELS = ['30', '50', '100', '200', '500', '1k', '2k', '5k', '10k', '20k']
const GRID_DB = [0, -12, -24, -36, -48, -60, -72, -84]

function freqToX(freq: number, w: number): number {
  const logMin = Math.log10(FREQ_MIN)
  const logMax = Math.log10(FREQ_MAX)
  return ((Math.log10(freq) - logMin) / (logMax - logMin)) * w
}

function dbToY(db: number, _h: number, top: number, bottom: number): number {
  const clamped = Math.max(DB_MIN, Math.min(DB_MAX, db))
  return top + ((DB_MAX - clamped) / (DB_MAX - DB_MIN)) * (bottom - top)
}

export default function SpectrumAnalyzer({ syncedRef, isPlaying, trackIndex }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const synced = syncedRef.current
    if (!canvas || !synced) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const analyser = synced.getTrackAnalyser(trackIndex)
    if (!analyser) return
    analyser.fftSize = 8192 // Higher resolution
    analyser.smoothingTimeConstant = 0.75
    const sampleRate = synced.getSampleRate()
    const bufLen = analyser.frequencyBinCount
    const dataArr = new Float32Array(bufLen)
    const binHz = sampleRate / analyser.fftSize

    // Smoothed dB values per bin — seed from current data to avoid slow ramp-up
    const smoothed = new Float32Array(bufLen)
    analyser.getFloatFrequencyData(smoothed)

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

      // Get frequency data in dB
      analyser.getFloatFrequencyData(dataArr)

      // Smooth and draw line
      ctx!.beginPath()
      let started = false
      for (let bin = 1; bin < bufLen; bin++) {
        const freq = bin * binHz
        if (freq < FREQ_MIN || freq > FREQ_MAX) continue

        const rawDb = dataArr[bin]
        smoothed[bin] += (rawDb - smoothed[bin]) * 0.4

        const x = freqToX(freq, w)
        const y = dbToY(smoothed[bin], h, padTop, h - padBottom)

        if (!started) {
          ctx!.moveTo(x, y)
          started = true
        } else {
          ctx!.lineTo(x, y)
        }
      }

      // Stroke the line
      ctx!.strokeStyle = '#cc0000'
      ctx!.lineWidth = 1.5
      ctx!.lineJoin = 'round'
      ctx!.stroke()

      // Fill under the curve
      if (started) {
        ctx!.lineTo(freqToX(FREQ_MAX, w), h - padBottom)
        ctx!.lineTo(freqToX(FREQ_MIN, w), h - padBottom)
        ctx!.closePath()
        const grad = ctx!.createLinearGradient(0, padTop, 0, h - padBottom)
        grad.addColorStop(0, 'rgba(204, 0, 0, 0.3)')
        grad.addColorStop(1, 'rgba(204, 0, 0, 0.02)')
        ctx!.fillStyle = grad
        ctx!.fill()
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    // Set canvas size at device resolution
    const rect = canvas.getBoundingClientRect()
    const dpr = devicePixelRatio || 1
    const cssW = rect.width
    const cssH = rect.height
    canvas.width = cssW * dpr
    canvas.height = cssH * dpr
    ctx.scale(dpr, dpr)

    draw()

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [syncedRef, isPlaying, trackIndex])

  return (
    <div className="analyzer-panel">
      <div className="analyzer-label">Spectrum</div>
      <canvas ref={canvasRef} className="analyzer-canvas spectrum-canvas" />
    </div>
  )
}
