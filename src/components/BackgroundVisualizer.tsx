import { useEffect, useRef } from 'react'
import { useBackgroundVisualizer } from '../contexts/BackgroundVisualizerContext'

// Decorative background visualizer — pulses to BPM while playing
export default function BackgroundVisualizer() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number | null>(null)
  const { bpmRef, isPlayingRef: playingRef } = useBackgroundVisualizer()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let w = 0, h = 0
    const dpr = devicePixelRatio || 1

    function resize() {
      w = window.innerWidth
      h = window.innerHeight
      canvas!.width = w * dpr
      canvas!.height = h * dpr
      ctx!.scale(dpr, dpr)
    }
    resize()
    window.addEventListener('resize', resize)

    // Particles for ambient motion
    const NUM = 80
    const particles = Array.from({ length: NUM }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      radius: Math.random() * 2 + 1,
      baseAlpha: Math.random() * 0.3 + 0.05,
    }))

    let t = 0
    let beatPhase = 0 // 0..1 cycles per bar
    let brightness = 0 // 0 = dark (paused), 1 = full (playing)
    let lastFrame = performance.now()

    function draw() {
      const now = performance.now()
      const dt = (now - lastFrame) / 1000
      lastFrame = now
      t += 0.003

      // Advance beat phase when playing — one cycle per bar (4 beats)
      if (playingRef.current && bpmRef.current > 0) {
        const barsPerSec = bpmRef.current / 60 / 4
        beatPhase = (beatPhase + dt * barsPerSec) % 1
      }

      // Gentle sinusoidal pulse over the full bar
      const beatWave = (1 + Math.cos(beatPhase * Math.PI * 2)) * 0.5 // 0..1 smooth
      const pulse = playingRef.current ? beatWave * 0.35 : 0

      ctx!.setTransform(1, 0, 0, 1, 0, 0)
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height)
      ctx!.scale(dpr, dpr)

      // Smoothly interpolate gradient brightness based on play state
      const targetBright = playingRef.current ? 1 : 0
      brightness += (targetBright - brightness) * 0.02

      // Two overlapping radial gradients for a smooth, band-free wash
      const cx1 = w / 2 + Math.sin(t) * w * 0.2
      const cy1 = h / 2 + Math.cos(t * 0.7) * h * 0.2
      const cx2 = w / 2 + Math.cos(t * 0.6) * w * 0.15
      const cy2 = h / 2 + Math.sin(t * 0.9) * h * 0.15
      const maxDim = Math.max(w, h)
      const b = brightness

      const g1 = ctx!.createRadialGradient(cx1, cy1, 0, cx1, cy1, maxDim * 0.8)
      g1.addColorStop(0, `rgba(95, 20, 15, ${0.05 + b * 0.13})`)
      g1.addColorStop(0.4, `rgba(75, 15, 10, ${0.03 + b * 0.07})`)
      g1.addColorStop(0.7, `rgba(50, 10, 8, ${0.01 + b * 0.03})`)
      g1.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx!.fillStyle = g1
      ctx!.fillRect(0, 0, w, h)

      const g2 = ctx!.createRadialGradient(cx2, cy2, 0, cx2, cy2, maxDim * 0.7)
      g2.addColorStop(0, `rgba(100, 30, 15, ${0.04 + b * 0.10})`)
      g2.addColorStop(0.4, `rgba(80, 20, 10, ${0.02 + b * 0.05})`)
      g2.addColorStop(0.7, `rgba(50, 12, 8, ${0.01 + b * 0.02})`)
      g2.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx!.fillStyle = g2
      ctx!.fillRect(0, 0, w, h)

      // Floating particles — subtle size and brightness shift
      const radiusMul = 1 + pulse * 0.4
      const alphaMul = 1 + pulse * 0.6
      for (const p of particles) {
        const speed = 1 + pulse * 0.5
        p.x += p.vx * speed
        p.y += p.vy * speed
        if (p.x < 0) p.x = w
        if (p.x > w) p.x = 0
        if (p.y < 0) p.y = h
        if (p.y > h) p.y = 0

        ctx!.beginPath()
        ctx!.arc(p.x, p.y, p.radius * radiusMul, 0, Math.PI * 2)
        ctx!.fillStyle = `rgba(220, 140, 120, ${Math.min(1, p.baseAlpha * alphaMul)})`
        ctx!.fill()
      }

      // Connection lines between close particles
      const connectDist = 120 + pulse * 20
      for (let i = 0; i < NUM; i++) {
        for (let j = i + 1; j < NUM; j++) {
          const dx = particles[i].x - particles[j].x
          const dy = particles[i].y - particles[j].y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < connectDist) {
            ctx!.beginPath()
            ctx!.moveTo(particles[i].x, particles[i].y)
            ctx!.lineTo(particles[j].x, particles[j].y)
            ctx!.strokeStyle = `rgba(180, 120, 100, ${(1 - dist / connectDist) * (0.08 + pulse * 0.04)})`
            ctx!.lineWidth = 0.5 + pulse * 0.3
            ctx!.stroke()
          }
        }
      }

      rafRef.current = requestAnimationFrame(draw)
    }
    draw()

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={canvasRef} className="blind-bg-canvas" />
}
