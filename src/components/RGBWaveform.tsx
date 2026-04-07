import { useEffect, useRef, useCallback } from 'react'
import type { SyncedWaveforms } from '../lib/waveforms'
import type { WaveformColorData } from '../lib/waveformAnalysis'

interface Props {
  syncedRef: React.MutableRefObject<SyncedWaveforms | null>
  colorData: WaveformColorData | null
  duration: number            // max duration (for proportional sizing)
  trackDuration: number       // this track's actual duration
  isActive: boolean
  activeColor?: string
  onClick?: (progress: number) => void
  onDoubleClick?: (progress: number) => void
  children?: React.ReactNode  // for comment marker overlay
}

const DIM_FACTOR = 0.3

export default function RGBWaveform({
  syncedRef,
  colorData,
  duration,
  trackDuration,
  isActive,
  activeColor = '#cc0000',
  onClick,
  onDoubleClick,
  children,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const brightRef = useRef<HTMLCanvasElement | null>(null)
  const dimRef = useRef<HTMLCanvasElement | null>(null)
  const sizeRef = useRef({ w: 0, h: 0 })
  const rafRef = useRef<number | null>(null)
  const hoverXRef = useRef<number | null>(null)

  const composite = useCallback(() => {
    const canvas = canvasRef.current
    const bright = brightRef.current
    const dim = dimRef.current
    const synced = syncedRef.current
    if (!canvas || !bright || !dim || !synced) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { w, h } = sizeRef.current
    const dpr = devicePixelRatio || 1
    const dur = synced.getDuration()
    const progress = dur > 0 ? synced.getCurrentTime() / dur : 0

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Draw dim (full width)
    ctx.drawImage(dim, 0, 0)

    // Draw bright (clipped to progress)
    const progressX = progress * w * dpr
    if (progressX > 0) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, progressX, h * dpr)
      ctx.clip()
      ctx.drawImage(bright, 0, 0)
      ctx.restore()
    }

    // Cursor line
    ctx.fillStyle = isActive ? activeColor : '#888'
    ctx.fillRect(progressX - 1, 0, 2, h * dpr)

    // Hover cursor
    const hoverX = hoverXRef.current
    if (hoverX !== null) {
      const hx = hoverX * dpr
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
      ctx.fillRect(hx - 1, 0, 2, h * dpr)
    }
  }, [syncedRef, isActive, activeColor])

  // Pre-render bright + dim canvases, then composite
  const renderBuffers = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !colorData) return

    const rect = canvas.getBoundingClientRect()
    const dpr = devicePixelRatio || 1
    const cssW = rect.width
    const cssH = rect.height
    if (cssW === 0 || cssH === 0) return

    canvas.width = cssW * dpr
    canvas.height = cssH * dpr
    sizeRef.current = { w: cssW, h: cssH }

    const pxW = Math.floor(cssW * dpr)
    const pxH = Math.floor(cssH * dpr)
    const ratio = duration > 0 ? trackDuration / duration : 1
    const activePx = Math.round(pxW * ratio)
    const totalSourceBars = colorData.bars.length

    const bright = document.createElement('canvas')
    bright.width = pxW
    bright.height = pxH
    const bCtx = bright.getContext('2d')!

    const dim = document.createElement('canvas')
    dim.width = pxW
    dim.height = pxH
    const dCtx = dim.getContext('2d')!

    const halfH = pxH / 2

    for (let px = 0; px < activePx; px++) {
      const srcStart = Math.floor((px * totalSourceBars) / activePx)
      const srcEnd = Math.max(srcStart + 1, Math.floor(((px + 1) * totalSourceBars) / activePx))
      let maxAmp = 0, peakR = 0, peakG = 0, peakB = 0
      for (let s = srcStart; s < srcEnd; s++) {
        const bar = colorData.bars[s]
        if (bar.amplitude > maxAmp) {
          maxAmp = bar.amplitude
          peakR = bar.r
          peakG = bar.g
          peakB = bar.b
        }
      }
      const barH = maxAmp * halfH
      if (barH < 0.5) continue

      bCtx.fillStyle = `rgb(${peakR},${peakG},${peakB})`
      bCtx.fillRect(px, halfH - barH, 1, barH * 2)

      dCtx.fillStyle = `rgb(${Math.round(peakR * DIM_FACTOR)},${Math.round(peakG * DIM_FACTOR)},${Math.round(peakB * DIM_FACTOR)})`
      dCtx.fillRect(px, halfH - barH, 1, barH * 2)
    }

    brightRef.current = bright
    dimRef.current = dim
    composite()
  }, [colorData, duration, trackDuration, composite])

  // Resize observer + initial render
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ro = new ResizeObserver(() => renderBuffers())
    ro.observe(canvas)
    renderBuffers()

    return () => ro.disconnect()
  }, [renderBuffers])

  // Own RAF loop for smooth cursor — bypasses React state entirely
  useEffect(() => {
    function tick() {
      composite()
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composite])

  return (
    <div className="waveform-container rgb-waveform-wrapper"
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        hoverXRef.current = e.clientX - rect.left
      }}
      onMouseLeave={() => { hoverXRef.current = null }}
      onClick={(e) => {
        if (!onClick) return
        const rect = e.currentTarget.getBoundingClientRect()
        const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        onClick(p)
      }}
      onDoubleClick={(e) => {
        if (!onDoubleClick) return
        const rect = e.currentTarget.getBoundingClientRect()
        const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
        onDoubleClick(p)
      }}
    >
      <canvas ref={canvasRef} className="rgb-waveform-canvas" />
      {children}
    </div>
  )
}
