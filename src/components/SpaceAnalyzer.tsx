import { useEffect, useRef, useState } from 'react'
import type { SyncedWaveforms } from '../lib/waveforms'

type SpaceMode = 'polar-sample' | 'polar-level' | 'lissajous'

const MODE_LABELS: Record<SpaceMode, string> = {
  'polar-sample': 'Polar Sample',
  'polar-level': 'Polar Level',
  'lissajous': 'Lissajous',
}

interface Props {
  syncedRef: React.MutableRefObject<SyncedWaveforms | null>
  isPlaying: boolean
  trackIndex: number
  accentColor?: string
  otherAccentColor?: string
  showOverlay?: boolean
}

// Fixed-size particle pool using typed arrays — zero per-frame allocation
const MAX_PARTICLES = 2000
const PARTICLE_LIFESPAN = 40 // frames
const NUM_LEVEL_BANDS = 64 // angular bins for polar level
const TRAIL_LEN = 4096

function parseHexColor(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

function buildColorCache(r: number, g: number, b: number, maxAlpha: number): string[] {
  const cache: string[] = new Array(256)
  for (let a = 0; a < 256; a++) {
    cache[a] = `rgba(${r},${g},${b},${(a / 255 * maxAlpha).toFixed(3)})`
  }
  return cache
}

export default function SpaceAnalyzer({
  syncedRef, isPlaying, trackIndex,
  accentColor = '#b48cff', otherAccentColor = '#888888',
  showOverlay = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number | null>(null)
  const [mode, setMode] = useState<SpaceMode>('polar-sample')
  const modeRef = useRef<SpaceMode>(mode)
  modeRef.current = mode
  const showOverlayRef = useRef(false)
  showOverlayRef.current = showOverlay

  useEffect(() => {
    const canvas = canvasRef.current
    const synced = syncedRef.current
    if (!canvas || !synced) return

    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    // Primary track analysers
    const analyserL = synced.getTrackAnalyserL(trackIndex)
    const analyserR = synced.getTrackAnalyserR(trackIndex)
    if (!analyserL || !analyserR) return
    analyserL.fftSize = 2048
    analyserR.fftSize = 2048
    const bufLen = analyserL.frequencyBinCount
    const dataL = new Float32Array(bufLen)
    const dataR = new Float32Array(bufLen)

    // Other track analysers (for overlay)
    const otherIndex = trackIndex === 0 ? 1 : 0
    const otherAnalyserL = synced.getTrackAnalyserL(otherIndex)
    const otherAnalyserR = synced.getTrackAnalyserR(otherIndex)
    const otherDataL = new Float32Array(bufLen)
    const otherDataR = new Float32Array(bufLen)
    const hasOther = !!(otherAnalyserL && otherAnalyserR)
    if (hasOther) {
      otherAnalyserL!.fftSize = 2048
      otherAnalyserR!.fftSize = 2048
    }

    // HiDPI setup
    const rect = canvas.getBoundingClientRect()
    const dpr = devicePixelRatio || 1
    const cssW = rect.width
    const cssH = rect.height
    canvas.width = cssW * dpr
    canvas.height = cssH * dpr
    ctx.scale(dpr, dpr)

    // ── Primary track state ──
    const pX = new Float32Array(MAX_PARTICLES)
    const pY = new Float32Array(MAX_PARTICLES)
    const pAge = new Float32Array(MAX_PARTICLES)
    const pMaxAge = new Float32Array(MAX_PARTICLES)
    const pIntensity = new Float32Array(MAX_PARTICLES)
    let pHead = 0
    let pCount = 0

    const smoothBins = new Float64Array(NUM_LEVEL_BANDS)
    const binEnergy = new Float64Array(NUM_LEVEL_BANDS)

    const trailX = new Float32Array(TRAIL_LEN)
    const trailY = new Float32Array(TRAIL_LEN)
    let trailHead = 0
    let trailCount = 0

    // ── Overlay track state ──
    const oPX = new Float32Array(MAX_PARTICLES)
    const oPY = new Float32Array(MAX_PARTICLES)
    const oPAge = new Float32Array(MAX_PARTICLES)
    const oPMaxAge = new Float32Array(MAX_PARTICLES)
    const oPIntensity = new Float32Array(MAX_PARTICLES)
    let oPHead = 0
    let oPCount = 0

    const oSmoothBins = new Float64Array(NUM_LEVEL_BANDS)
    const oBinEnergy = new Float64Array(NUM_LEVEL_BANDS)

    const oTrailX = new Float32Array(TRAIL_LEN)
    const oTrailY = new Float32Array(TRAIL_LEN)
    let oTrailHead = 0
    let oTrailCount = 0

    // Smoothed indicators
    let smoothCorrelation = 0
    let smoothBalance = 0
    let smoothWidth = 0

    // Parse colors
    const [pr, pg, pb] = parseHexColor(accentColor)
    const [or, og, ob] = parseHexColor(otherAccentColor)

    // Pre-computed color caches
    const PARTICLE_COLOR_CACHE = buildColorCache(pr, pg, pb, 0.9)
    const OVERLAY_COLOR_CACHE = buildColorCache(or, og, ob, 0.6)

    function draw() {
      const currentMode = modeRef.current
      const overlay = showOverlayRef.current && hasOther
      const w = cssW
      const h = cssH

      // Layout
      const barAreaH = 44
      const polarCenterX = w / 2
      const polarBottomY = h - barAreaH - 8
      const polarRadiusBase = Math.min(w / 2 - 20, polarBottomY - 16)
      const polarRadius = currentMode === 'lissajous'
        ? Math.min(w / 2 - 30, (h - barAreaH) / 2 - 20)
        : polarRadiusBase
      const polarCenterY = currentMode === 'lissajous'
        ? (h - barAreaH) / 2
        : polarBottomY

      ctx!.fillStyle = '#0a0a0a'
      ctx!.fillRect(0, 0, w, h)

      // Read primary track data
      analyserL.getFloatTimeDomainData(dataL)
      analyserR.getFloatTimeDomainData(dataR)

      // Read overlay track data
      if (overlay) {
        otherAnalyserL!.getFloatTimeDomainData(otherDataL)
        otherAnalyserR!.getFloatTimeDomainData(otherDataR)
      }

      // Compute correlation and balance (primary only)
      let sumLR = 0, sumLL = 0, sumRR = 0
      for (let i = 0; i < bufLen; i++) {
        sumLR += dataL[i] * dataR[i]
        sumLL += dataL[i] * dataL[i]
        sumRR += dataR[i] * dataR[i]
      }
      const denom = Math.sqrt(sumLL * sumRR)
      const correlation = denom > 0 ? sumLR / denom : 0
      smoothCorrelation += (correlation - smoothCorrelation) * 0.12

      const energyL = sumLL / bufLen
      const energyR = sumRR / bufLen
      const totalEnergy = energyL + energyR
      const balance = totalEnergy > 0 ? (energyR - energyL) / totalEnergy : 0
      smoothBalance += (balance - smoothBalance) * 0.12

      const width = Math.max(0, Math.min(1, 1 - smoothCorrelation))
      smoothWidth += (width - smoothWidth) * 0.1

      // ── Mode-specific visualization ──
      if (currentMode === 'lissajous') {
        drawLissajousGuides(ctx!, polarCenterX, polarCenterY, polarRadius)
        if (overlay) { const oo = drawLissajousTrail(ctx!, otherDataL, otherDataR, polarCenterX, polarCenterY, polarRadius, oTrailX, oTrailY, oTrailHead, oTrailCount, OVERLAY_COLOR_CACHE); oTrailHead = oo.head; oTrailCount = oo.count }
        const ot = drawLissajousTrail(ctx!, dataL, dataR, polarCenterX, polarCenterY, polarRadius, trailX, trailY, trailHead, trailCount, PARTICLE_COLOR_CACHE)
        trailHead = ot.head; trailCount = ot.count
      } else if (currentMode === 'polar-level') {
        drawPolarGuides(ctx!, polarCenterX, polarCenterY, polarRadius)
        if (overlay) drawPolarLevelShape(ctx!, otherDataL, otherDataR, polarCenterX, polarCenterY, polarRadius, oBinEnergy, oSmoothBins, or, og, ob)
        drawPolarLevelShape(ctx!, dataL, dataR, polarCenterX, polarCenterY, polarRadius, binEnergy, smoothBins, pr, pg, pb)
      } else {
        drawPolarGuides(ctx!, polarCenterX, polarCenterY, polarRadius)
        if (overlay) { const oo = drawPolarSampleParticles(ctx!, otherDataL, otherDataR, polarCenterX, polarCenterY, polarRadius, oPX, oPY, oPAge, oPMaxAge, oPIntensity, oPHead, oPCount, OVERLAY_COLOR_CACHE); oPHead = oo.head; oPCount = oo.count }
        const op = drawPolarSampleParticles(ctx!, dataL, dataR, polarCenterX, polarCenterY, polarRadius, pX, pY, pAge, pMaxAge, pIntensity, pHead, pCount, PARTICLE_COLOR_CACHE)
        pHead = op.head; pCount = op.count
      }

      // ── Width arc indicator ──
      const widthAngleSpan = smoothWidth * Math.PI
      const arcStart = Math.PI / 2 + widthAngleSpan / 2
      const arcEnd = Math.PI / 2 - widthAngleSpan / 2
      const arcR = polarRadius + 6

      ctx!.lineWidth = 3
      const arcGrad = ctx!.createLinearGradient(
        polarCenterX - arcR, polarCenterY,
        polarCenterX + arcR, polarCenterY,
      )
      arcGrad.addColorStop(0, `rgba(${pr},${pg},${pb},0.3)`)
      arcGrad.addColorStop(0.5, `rgba(${pr},${pg},${pb},0.7)`)
      arcGrad.addColorStop(1, `rgba(${pr},${pg},${pb},0.3)`)
      ctx!.strokeStyle = arcGrad
      ctx!.beginPath()
      if (currentMode === 'lissajous') {
        ctx!.moveTo(polarCenterX, polarCenterY - arcR)
        ctx!.lineTo(polarCenterX + arcR, polarCenterY)
        ctx!.lineTo(polarCenterX, polarCenterY + arcR)
        ctx!.lineTo(polarCenterX - arcR, polarCenterY)
        ctx!.closePath()
      } else {
        ctx!.arc(polarCenterX, polarCenterY, arcR, Math.PI + (Math.PI - arcStart), Math.PI + (Math.PI - arcEnd))
      }
      ctx!.stroke()

      // Width percentage text
      const widthLabelY = currentMode === 'lissajous'
        ? polarCenterY - polarRadius - 12
        : polarCenterY - polarRadius - 18
      ctx!.fillStyle = `rgba(${pr},${pg},${pb},0.8)`
      ctx!.font = 'bold 11px sans-serif'
      ctx!.textAlign = 'center'
      ctx!.fillText(`${Math.round(smoothWidth * 100)}%`, polarCenterX, widthLabelY)
      ctx!.fillStyle = 'rgba(255, 255, 255, 0.3)'
      ctx!.font = '8px sans-serif'
      ctx!.fillText('WIDTH', polarCenterX, widthLabelY - 10)

      // ── Correlation bar ──
      const barW = w - 40
      const barX = 20
      const corrBarY = h - 14

      ctx!.fillStyle = '#181818'
      ctx!.beginPath()
      ctx!.roundRect(barX, corrBarY - 4, barW, 8, 4)
      ctx!.fill()

      const corrFillW = barW * 0.04
      const corrX = barX + ((smoothCorrelation + 1) / 2) * barW
      const corrGradient = ctx!.createLinearGradient(corrX - corrFillW, 0, corrX + corrFillW, 0)
      const corrColorArr = smoothCorrelation > 0.3 ? [100, 220, 100] : smoothCorrelation < -0.1 ? [255, 70, 70] : [255, 170, 50]
      corrGradient.addColorStop(0, `rgba(${corrColorArr[0]},${corrColorArr[1]},${corrColorArr[2]},0)`)
      corrGradient.addColorStop(0.5, `rgba(${corrColorArr[0]},${corrColorArr[1]},${corrColorArr[2]},0.9)`)
      corrGradient.addColorStop(1, `rgba(${corrColorArr[0]},${corrColorArr[1]},${corrColorArr[2]},0)`)
      ctx!.fillStyle = corrGradient
      ctx!.beginPath()
      ctx!.roundRect(corrX - corrFillW, corrBarY - 4, corrFillW * 2, 8, 4)
      ctx!.fill()

      ctx!.fillStyle = `rgb(${corrColorArr[0]},${corrColorArr[1]},${corrColorArr[2]})`
      ctx!.beginPath()
      ctx!.arc(corrX, corrBarY, 4, 0, Math.PI * 2)
      ctx!.fill()

      ctx!.fillStyle = 'rgba(255, 255, 255, 0.3)'
      ctx!.font = '8px sans-serif'
      ctx!.textAlign = 'left'
      ctx!.fillText('-1', barX, corrBarY + 14)
      ctx!.textAlign = 'center'
      ctx!.fillText('CORRELATION', barX + barW / 2, corrBarY + 14)
      ctx!.fillText(smoothCorrelation.toFixed(2), barX + barW / 2, corrBarY - 10)
      ctx!.textAlign = 'right'
      ctx!.fillText('+1', barX + barW, corrBarY + 14)

      // ── Balance bar ──
      const balBarY = corrBarY - 26

      ctx!.fillStyle = '#181818'
      ctx!.beginPath()
      ctx!.roundRect(barX, balBarY - 4, barW, 8, 4)
      ctx!.fill()

      ctx!.fillStyle = 'rgba(255, 255, 255, 0.08)'
      ctx!.fillRect(barX + barW / 2 - 0.5, balBarY - 4, 1, 8)

      const balX = barX + ((smoothBalance + 1) / 2) * barW
      const balColor = Math.abs(smoothBalance) < 0.05 ? '100, 220, 100' : '255, 170, 50'
      ctx!.fillStyle = `rgba(${balColor}, 1)`
      ctx!.beginPath()
      ctx!.arc(balX, balBarY, 4, 0, Math.PI * 2)
      ctx!.fill()

      ctx!.fillStyle = 'rgba(255, 255, 255, 0.3)'
      ctx!.font = '8px sans-serif'
      ctx!.textAlign = 'left'
      ctx!.fillText('L', barX, balBarY + 14)
      ctx!.textAlign = 'center'
      ctx!.fillText('BALANCE', barX + barW / 2, balBarY + 14)
      ctx!.textAlign = 'right'
      ctx!.fillText('R', barX + barW, balBarY + 14)

      rafRef.current = requestAnimationFrame(draw)
    }

    // ── Polar Sample helpers ───────────────────────────────────────────
    function drawPolarSampleParticles(
      c: CanvasRenderingContext2D,
      dL: Float32Array, dR: Float32Array,
      cx: number, cy: number, radius: number,
      ppX: Float32Array, ppY: Float32Array, ppAge: Float32Array,
      ppMaxAge: Float32Array, ppIntensity: Float32Array,
      head: number, count: number,
      colorCache: string[],
    ): { head: number; count: number } {
      // Spawn particles
      const step = Math.max(1, Math.floor(bufLen / 512))
      for (let i = 0; i < bufLen; i += step) {
        const l = dL[i]
        const r = dR[i]
        const mid = (l + r) * 0.5
        const side = (l - r) * 0.5
        const amplitude = Math.sqrt(mid * mid + side * side)
        if (amplitude < 0.002) continue

        const pan = Math.atan2(side, mid)
        const angle = Math.PI / 2 - pan
        const dist = Math.min(amplitude * 6, 1) * radius
        const px = cx + Math.cos(angle) * dist
        const py = cy - Math.sin(angle) * dist

        if (py <= cy) {
          ppX[head] = px
          ppY[head] = py
          ppAge[head] = 0
          ppMaxAge[head] = PARTICLE_LIFESPAN + Math.random() * 15
          ppIntensity[head] = Math.min(1, amplitude * 4)
          head = (head + 1) % MAX_PARTICLES
          if (count < MAX_PARTICLES) count++
        }
      }

      // Draw particles
      for (let i = 0; i < count; i++) {
        ppAge[i]++
        if (ppAge[i] > ppMaxAge[i]) continue
        const life = 1 - ppAge[i] / ppMaxAge[i]
        const alpha = life * life * ppIntensity[i]
        const size = 0.8 + ppIntensity[i] * 0.7
        const alphaIdx = (alpha * 255 + 0.5) | 0
        if (alphaIdx <= 0) continue
        c.fillStyle = colorCache[alphaIdx < 256 ? alphaIdx : 255]
        c.fillRect(ppX[i] - size * 0.5, ppY[i] - size * 0.5, size, size)
      }

      return { head, count }
    }

    // ── Polar Level helpers ────────────────────────────────────────────
    function drawPolarLevelShape(
      c: CanvasRenderingContext2D,
      dL: Float32Array, dR: Float32Array,
      cx: number, cy: number, radius: number,
      bEnergy: Float64Array, sBins: Float64Array,
      cr: number, cg: number, cb: number,
    ) {
      bEnergy.fill(0)
      const binCounts = new Float64Array(NUM_LEVEL_BANDS)
      const step = Math.max(1, Math.floor(bufLen / 1024))
      for (let i = 0; i < bufLen; i += step) {
        const l = dL[i]
        const r = dR[i]
        const mid = (l + r) * 0.5
        const side = (l - r) * 0.5
        const energy = mid * mid + side * side
        if (energy < 1e-8) continue

        const pan = Math.atan2(side, mid)
        const angle = Math.max(0, Math.min(Math.PI, Math.PI / 2 - pan))
        const bin = Math.min(NUM_LEVEL_BANDS - 1, (angle / Math.PI * NUM_LEVEL_BANDS) | 0)
        bEnergy[bin] += energy
        binCounts[bin]++
      }

      for (let b = 0; b < NUM_LEVEL_BANDS; b++) {
        const avg = binCounts[b] > 0 ? bEnergy[b] / binCounts[b] : 0
        const level = Math.sqrt(avg)
        sBins[b] += (level - sBins[b]) * 0.2
      }

      let maxLevel = 0
      for (let b = 0; b < NUM_LEVEL_BANDS; b++) {
        if (sBins[b] > maxLevel) maxLevel = sBins[b]
      }
      const norm = maxLevel > 1e-6 ? 1 / maxLevel : 0

      // Filled shape
      c.beginPath()
      for (let b = 0; b < NUM_LEVEL_BANDS; b++) {
        const angle = ((b + 0.5) / NUM_LEVEL_BANDS) * Math.PI
        const dist = sBins[b] * norm * radius
        const x = cx + Math.cos(Math.PI - angle) * dist
        const y = cy - Math.sin(Math.PI - angle) * dist
        if (b === 0) c.moveTo(x, y)
        else c.lineTo(x, y)
      }
      c.closePath()
      c.fillStyle = `rgba(${cr},${cg},${cb},0.18)`
      c.fill()
      c.strokeStyle = `rgba(${cr},${cg},${cb},0.6)`
      c.lineWidth = 1.5
      c.stroke()

      // Rays
      c.lineWidth = 1
      for (let b = 0; b < NUM_LEVEL_BANDS; b++) {
        const level = sBins[b] * norm
        if (level < 0.02) continue
        const angle = ((b + 0.5) / NUM_LEVEL_BANDS) * Math.PI
        const dist = level * radius
        const alpha = Math.min(0.4, level * 0.5)
        c.strokeStyle = `rgba(${cr},${cg},${cb},${alpha.toFixed(3)})`
        c.beginPath()
        c.moveTo(cx, cy)
        c.lineTo(cx + Math.cos(Math.PI - angle) * dist, cy - Math.sin(Math.PI - angle) * dist)
        c.stroke()
      }
    }

    // ── Lissajous helpers ──────────────────────────────────────────────
    function drawLissajousGuides(
      c: CanvasRenderingContext2D,
      cx: number, cy: number, radius: number,
    ) {
      // Diamond boundary
      c.strokeStyle = 'rgba(255, 255, 255, 0.08)'
      c.lineWidth = 1
      c.beginPath()
      c.moveTo(cx, cy - radius)
      c.lineTo(cx + radius, cy)
      c.lineTo(cx, cy + radius)
      c.lineTo(cx - radius, cy)
      c.closePath()
      c.stroke()

      for (let r = 0.25; r < 1; r += 0.25) {
        c.strokeStyle = 'rgba(255, 255, 255, 0.03)'
        c.beginPath()
        c.moveTo(cx, cy - radius * r)
        c.lineTo(cx + radius * r, cy)
        c.lineTo(cx, cy + radius * r)
        c.lineTo(cx - radius * r, cy)
        c.closePath()
        c.stroke()
      }

      // L/R diagonals
      c.strokeStyle = 'rgba(255, 255, 255, 0.05)'
      c.beginPath()
      c.moveTo(cx - radius * 0.707, cy - radius * 0.707)
      c.lineTo(cx + radius * 0.707, cy + radius * 0.707)
      c.stroke()
      c.beginPath()
      c.moveTo(cx - radius * 0.707, cy + radius * 0.707)
      c.lineTo(cx + radius * 0.707, cy - radius * 0.707)
      c.stroke()

      // M/S axes
      c.strokeStyle = 'rgba(255, 255, 255, 0.06)'
      c.beginPath()
      c.moveTo(cx - radius, cy)
      c.lineTo(cx + radius, cy)
      c.stroke()
      c.beginPath()
      c.moveTo(cx, cy - radius)
      c.lineTo(cx, cy + radius)
      c.stroke()

      // Labels
      c.fillStyle = 'rgba(255, 255, 255, 0.25)'
      c.font = '10px sans-serif'
      c.textAlign = 'left'
      c.fillText('+S', cx + radius + 4, cy + 4)
      c.textAlign = 'right'
      c.fillText('-S', cx - radius - 4, cy + 4)
      c.textAlign = 'center'
      c.fillText('+M', cx, cy - radius - 4)
      c.fillText('-M', cx, cy + radius + 12)
      c.textAlign = 'right'
      c.fillText('L', cx - radius * 0.707 - 4, cy - radius * 0.707 - 2)
      c.textAlign = 'left'
      c.fillText('R', cx + radius * 0.707 + 4, cy - radius * 0.707 - 2)
    }

    function drawLissajousTrail(
      c: CanvasRenderingContext2D,
      dL: Float32Array, dR: Float32Array,
      cx: number, cy: number, radius: number,
      tX: Float32Array, tY: Float32Array,
      head: number, count: number,
      colorCache: string[],
    ): { head: number; count: number } {
      // Add current samples to trail
      const step = Math.max(1, Math.floor(bufLen / 512))
      for (let i = 0; i < bufLen; i += step) {
        const l = dL[i]
        const r = dR[i]
        const x = (r - l) * 0.707
        const y = (l + r) * 0.707
        tX[head] = cx + x * radius
        tY[head] = cy - y * radius
        head = (head + 1) % TRAIL_LEN
        if (count < TRAIL_LEN) count++
      }

      // Draw trail with fade
      for (let i = 0; i < count; i++) {
        const age = (head - 1 - i + TRAIL_LEN) % TRAIL_LEN
        const life = 1 - age / count
        const alphaIdx = (life * life * 255 + 0.5) | 0
        if (alphaIdx <= 0) continue
        c.fillStyle = colorCache[alphaIdx < 256 ? alphaIdx : 255]
        const idx = (head - 1 - i + TRAIL_LEN) % TRAIL_LEN
        c.fillRect(tX[idx] - 0.5, tY[idx] - 0.5, 1, 1)
      }

      return { head, count }
    }

    // ── Shared polar guides ────────────────────────────────────────────
    function drawPolarGuides(
      c: CanvasRenderingContext2D,
      cx: number, cy: number, radius: number,
    ) {
      c.strokeStyle = 'rgba(255, 255, 255, 0.06)'
      c.lineWidth = 1
      c.beginPath()
      c.arc(cx, cy, radius, Math.PI, 0)
      c.stroke()

      for (let r = 0.25; r < 1; r += 0.25) {
        c.strokeStyle = 'rgba(255, 255, 255, 0.03)'
        c.beginPath()
        c.arc(cx, cy, radius * r, Math.PI, 0)
        c.stroke()
      }

      const angles = [Math.PI, Math.PI * 0.75, Math.PI * 0.5, Math.PI * 0.25, 0]
      for (const angle of angles) {
        c.strokeStyle = 'rgba(255, 255, 255, 0.05)'
        c.beginPath()
        c.moveTo(cx, cy)
        c.lineTo(cx + Math.cos(angle) * radius, cy - Math.sin(angle) * radius)
        c.stroke()
      }

      c.strokeStyle = 'rgba(255, 255, 255, 0.08)'
      c.beginPath()
      c.moveTo(cx - radius, cy)
      c.lineTo(cx + radius, cy)
      c.stroke()

      c.fillStyle = 'rgba(255, 255, 255, 0.25)'
      c.font = '10px sans-serif'
      c.textAlign = 'center'
      c.fillText('M', cx, cy - radius - 6)
      c.textAlign = 'right'
      c.fillText('L', cx - radius - 6, cy + 4)
      c.textAlign = 'left'
      c.fillText('R', cx + radius + 6, cy + 4)
    }

    draw()

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [syncedRef, isPlaying, trackIndex, accentColor, otherAccentColor, showOverlay])

  return (
    <div className="analyzer-panel">
      <div className="analyzer-label">Stereo Field</div>
      <canvas ref={canvasRef} className="analyzer-canvas space-canvas" />
      <div className="space-mode-tabs">
        {(Object.keys(MODE_LABELS) as SpaceMode[]).map((key) => (
          <button
            key={key}
            type="button"
            className={`space-mode-tab${mode === key ? ' active' : ''}`}
            onClick={() => setMode(key)}
          >
            {MODE_LABELS[key]}
          </button>
        ))}
      </div>
    </div>
  )
}
