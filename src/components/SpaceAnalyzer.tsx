import { useEffect, useRef } from 'react'
import type { SyncedWaveforms } from '../lib/waveforms'

interface Props {
  syncedRef: React.MutableRefObject<SyncedWaveforms | null>
  isPlaying: boolean
  trackIndex: number
}

// Particle pool for the vectorscope
interface Particle {
  x: number
  y: number
  age: number
  maxAge: number
  intensity: number
}

const MAX_PARTICLES = 2000
const PARTICLE_LIFESPAN = 40 // frames

export default function SpaceAnalyzer({ syncedRef, isPlaying, trackIndex }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const synced = syncedRef.current
    if (!canvas || !synced) return

    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    const analyserL = synced.getTrackAnalyserL(trackIndex)
    const analyserR = synced.getTrackAnalyserR(trackIndex)
    if (!analyserL || !analyserR) return
    analyserL.fftSize = 2048
    analyserR.fftSize = 2048
    const bufLen = analyserL.frequencyBinCount
    const dataL = new Float32Array(bufLen)
    const dataR = new Float32Array(bufLen)

    // HiDPI setup
    const rect = canvas.getBoundingClientRect()
    const dpr = devicePixelRatio || 1
    const cssW = rect.width
    const cssH = rect.height
    canvas.width = cssW * dpr
    canvas.height = cssH * dpr
    ctx.scale(dpr, dpr)

    // Particle pool
    const particles: Particle[] = []

    // Smoothed indicators
    let smoothCorrelation = 0
    let smoothBalance = 0
    let smoothWidth = 0

    function draw() {
      const w = cssW
      const h = cssH

      // Layout: semicircle in upper portion, bars at bottom
      const barAreaH = 44
      const polarCenterX = w / 2
      const polarBottomY = h - barAreaH - 8
      const polarRadius = Math.min(w / 2 - 20, polarBottomY - 16)
      const polarCenterY = polarBottomY

      // Dark background with slight fade for trail persistence
      ctx!.fillStyle = '#0a0a0a'
      ctx!.fillRect(0, 0, w, h)

      analyserL.getFloatTimeDomainData(dataL)
      analyserR.getFloatTimeDomainData(dataR)

      // Compute correlation and balance
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

      // Width: 0 = mono, 1 = full stereo
      const width = Math.max(0, Math.min(1, 1 - smoothCorrelation))
      smoothWidth += (width - smoothWidth) * 0.1

      // ── Draw semicircle guides ──
      // Outer arc
      ctx!.strokeStyle = 'rgba(255, 255, 255, 0.06)'
      ctx!.lineWidth = 1
      ctx!.beginPath()
      ctx!.arc(polarCenterX, polarCenterY, polarRadius, Math.PI, 0)
      ctx!.stroke()

      // Inner rings
      for (let r = 0.25; r < 1; r += 0.25) {
        ctx!.strokeStyle = 'rgba(255, 255, 255, 0.03)'
        ctx!.beginPath()
        ctx!.arc(polarCenterX, polarCenterY, polarRadius * r, Math.PI, 0)
        ctx!.stroke()
      }

      // Radial lines: L, center, R and 45° marks
      const angles = [Math.PI, Math.PI * 0.75, Math.PI * 0.5, Math.PI * 0.25, 0]
      for (const angle of angles) {
        ctx!.strokeStyle = 'rgba(255, 255, 255, 0.05)'
        ctx!.beginPath()
        ctx!.moveTo(polarCenterX, polarCenterY)
        ctx!.lineTo(
          polarCenterX + Math.cos(angle) * polarRadius,
          polarCenterY - Math.sin(angle) * polarRadius,
        )
        ctx!.stroke()
      }

      // Base line
      ctx!.strokeStyle = 'rgba(255, 255, 255, 0.08)'
      ctx!.beginPath()
      ctx!.moveTo(polarCenterX - polarRadius, polarCenterY)
      ctx!.lineTo(polarCenterX + polarRadius, polarCenterY)
      ctx!.stroke()

      // Labels
      ctx!.fillStyle = 'rgba(255, 255, 255, 0.25)'
      ctx!.font = '10px sans-serif'
      ctx!.textAlign = 'center'
      ctx!.fillText('M', polarCenterX, polarCenterY - polarRadius - 6)
      ctx!.textAlign = 'right'
      ctx!.fillText('L', polarCenterX - polarRadius - 6, polarCenterY + 4)
      ctx!.textAlign = 'left'
      ctx!.fillText('R', polarCenterX + polarRadius + 6, polarCenterY + 4)

      // ── Spawn particles from audio samples ──
      // Map L/R to polar half-circle: angle from L (π) to R (0), radius from amplitude
      const step = Math.max(1, Math.floor(bufLen / 512))
      for (let i = 0; i < bufLen; i += step) {
        const l = dataL[i]
        const r = dataR[i]
        const mid = (l + r) * 0.5
        const side = (l - r) * 0.5

        const amplitude = Math.sqrt(mid * mid + side * side)
        if (amplitude < 0.005) continue

        // Polar mapping: angle based on panning, radius based on amplitude
        // side/mid gives us the stereo angle
        const pan = Math.atan2(side, mid) // ranges roughly -π/2 to π/2
        // Map to semicircle: -π/2 → π (left), 0 → π/2 (center), π/2 → 0 (right)
        const angle = Math.PI / 2 - pan
        const dist = Math.min(amplitude * 2.5, 1) * polarRadius

        const px = polarCenterX + Math.cos(angle) * dist
        const py = polarCenterY - Math.sin(angle) * dist

        // Only keep particles in the upper half
        if (py <= polarCenterY) {
          particles.push({
            x: px,
            y: py,
            age: 0,
            maxAge: PARTICLE_LIFESPAN + Math.random() * 15,
            intensity: Math.min(1, amplitude * 4),
          })
        }
      }

      // Trim particle pool
      while (particles.length > MAX_PARTICLES) {
        particles.shift()
      }

      // ── Draw particles ──
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]
        p.age++
        if (p.age > p.maxAge) {
          particles.splice(i, 1)
          continue
        }

        const life = 1 - p.age / p.maxAge
        const alpha = life * life * p.intensity

        // Draw particle dot — small fixed-color point
        const size = 0.8 + p.intensity * 0.7
        ctx!.fillStyle = `rgba(180, 140, 255, ${alpha * 0.9})`
        ctx!.fillRect(p.x - size * 0.5, p.y - size * 0.5, size, size)
      }

      // ── Width arc indicator ──
      // Draw a colored arc showing the stereo width along the outer edge
      const widthAngleSpan = smoothWidth * Math.PI // 0 = thin line at center, π = full semicircle
      const arcStart = Math.PI / 2 + widthAngleSpan / 2
      const arcEnd = Math.PI / 2 - widthAngleSpan / 2
      const arcR = polarRadius + 6

      ctx!.lineWidth = 3
      const arcGrad = ctx!.createLinearGradient(
        polarCenterX - arcR, polarCenterY,
        polarCenterX + arcR, polarCenterY,
      )
      arcGrad.addColorStop(0, 'rgba(100, 200, 255, 0.7)')
      arcGrad.addColorStop(0.5, 'rgba(180, 120, 255, 0.7)')
      arcGrad.addColorStop(1, 'rgba(255, 80, 200, 0.7)')
      ctx!.strokeStyle = arcGrad
      ctx!.beginPath()
      ctx!.arc(polarCenterX, polarCenterY, arcR, Math.PI + (Math.PI - arcStart), Math.PI + (Math.PI - arcEnd))
      ctx!.stroke()

      // Width percentage text
      ctx!.fillStyle = 'rgba(180, 140, 255, 0.8)'
      ctx!.font = 'bold 11px sans-serif'
      ctx!.textAlign = 'center'
      ctx!.fillText(`${Math.round(smoothWidth * 100)}%`, polarCenterX, polarCenterY - polarRadius - 18)
      ctx!.fillStyle = 'rgba(255, 255, 255, 0.3)'
      ctx!.font = '8px sans-serif'
      ctx!.fillText('WIDTH', polarCenterX, polarCenterY - polarRadius - 28)

      // ── Correlation bar ──
      const barW = w - 40
      const barX = 20
      const corrBarY = h - 14

      // Bar track
      ctx!.fillStyle = '#181818'
      ctx!.beginPath()
      ctx!.roundRect(barX, corrBarY - 4, barW, 8, 4)
      ctx!.fill()

      // Gradient fill showing where correlation is
      const corrFillW = barW * 0.04
      const corrX = barX + ((smoothCorrelation + 1) / 2) * barW
      const corrGradient = ctx!.createLinearGradient(corrX - corrFillW, 0, corrX + corrFillW, 0)
      const corrColor = smoothCorrelation > 0.3 ? '100, 220, 100' : smoothCorrelation < -0.1 ? '255, 70, 70' : '255, 170, 50'
      corrGradient.addColorStop(0, 'rgba(' + corrColor + ', 0)')
      corrGradient.addColorStop(0.5, 'rgba(' + corrColor + ', 0.9)')
      corrGradient.addColorStop(1, 'rgba(' + corrColor + ', 0)')
      ctx!.fillStyle = corrGradient
      ctx!.beginPath()
      ctx!.roundRect(corrX - corrFillW, corrBarY - 4, corrFillW * 2, 8, 4)
      ctx!.fill()

      // Marker
      ctx!.fillStyle = `rgba(${corrColor}, 1)`
      ctx!.beginPath()
      ctx!.arc(corrX, corrBarY, 4, 0, Math.PI * 2)
      ctx!.fill()

      // Labels
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

      // Center marker
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

    draw()

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [syncedRef, isPlaying, trackIndex])

  return (
    <div className="analyzer-panel">
      <div className="analyzer-label">Stereo Field</div>
      <canvas ref={canvasRef} className="analyzer-canvas space-canvas" />
    </div>
  )
}
