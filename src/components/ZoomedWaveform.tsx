import { useEffect, useRef, useCallback } from 'react'
import type { SyncedWaveforms } from '../lib/waveforms'
import type { WaveformColorData } from '../lib/waveformAnalysis'

interface Props {
  syncedRef: React.MutableRefObject<SyncedWaveforms | null>
  colorData: WaveformColorData | null
  trackIndex: number
  visibleSeconds?: number
}

const DIM_FACTOR = 0.55
const TILE_WIDTH = 8192 // px per tile (well under canvas max)

// Module-level tile cache so tiles survive unmount/remount (zoom toggle).
// FIFO eviction keeps memory bounded — each entry holds pre-rendered canvas tiles.
const MAX_TILE_ENTRIES = 16
const tileCache = new Map<string, { bright: HTMLCanvasElement[]; dim: HTMLCanvasElement[]; h: number }>()

function tileCacheSet(key: string, value: { bright: HTMLCanvasElement[]; dim: HTMLCanvasElement[]; h: number }) {
  tileCache.set(key, value)
  if (tileCache.size > MAX_TILE_ENTRIES) {
    // Delete oldest entry (first key in insertion order)
    const first = tileCache.keys().next().value
    if (first !== undefined) tileCache.delete(first)
  }
}

export default function ZoomedWaveform({
  syncedRef,
  colorData,
  trackIndex,
  visibleSeconds = 4,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number | null>(null)
  // Pre-rendered tile canvases: bright[i] and dim[i] each TILE_WIDTH × tileH
  const brightTilesRef = useRef<HTMLCanvasElement[]>([])
  const dimTilesRef = useRef<HTMLCanvasElement[]>([])
  const tileHRef = useRef(0)
  const sizeRef = useRef({ w: 0, h: 0 })
  // Touch/mouse drag state
  const dragRef = useRef<{ startX: number; startTime: number; lastX: number; lastTs: number; velocity: number } | null>(null)
  const momentumRef = useRef<{ velocity: number; raf: number } | null>(null)

  // Build tile canvases — uses module-level cache so tiles survive unmount/remount
  const buildTiles = useCallback((pxH: number) => {
    if (!colorData || pxH === 0) return
    const cacheKey = `${colorData.bars.length}_${pxH}`
    const cached = tileCache.get(cacheKey)
    if (cached) {
      brightTilesRef.current = cached.bright
      dimTilesRef.current = cached.dim
      tileHRef.current = cached.h
      return
    }

    const bars = colorData.bars
    const totalBars = bars.length
    const numTiles = Math.ceil(totalBars / TILE_WIDTH)
    const halfH = pxH / 2

    const brightTiles: HTMLCanvasElement[] = new Array(numTiles)
    const dimTiles: HTMLCanvasElement[] = new Array(numTiles)

    for (let t = 0; t < numTiles; t++) {
      const startBar = t * TILE_WIDTH
      const endBar = Math.min(startBar + TILE_WIDTH, totalBars)
      const tileW = endBar - startBar

      const bc = document.createElement('canvas')
      bc.width = tileW
      bc.height = pxH
      const bCtx = bc.getContext('2d')!

      const dc = document.createElement('canvas')
      dc.width = tileW
      dc.height = pxH
      const dCtx = dc.getContext('2d')!

      for (let i = startBar; i < endBar; i++) {
        const bar = bars[i]
        const barH = bar.amplitude * halfH
        if (barH < 0.5) continue
        const px = i - startBar

        bCtx.fillStyle = `rgb(${bar.r},${bar.g},${bar.b})`
        bCtx.fillRect(px, halfH - barH, 1, barH * 2)

        dCtx.fillStyle = `rgb(${bar.r * DIM_FACTOR + 0.5 | 0},${bar.g * DIM_FACTOR + 0.5 | 0},${bar.b * DIM_FACTOR + 0.5 | 0})`
        dCtx.fillRect(px, halfH - barH, 1, barH * 2)
      }

      brightTiles[t] = bc
      dimTiles[t] = dc
    }

    brightTilesRef.current = brightTiles
    dimTilesRef.current = dimTiles
    tileHRef.current = pxH
    tileCacheSet(cacheKey, { bright: brightTiles, dim: dimTiles, h: pxH })
  }, [colorData])

  useEffect(() => {
    const canvas = canvasRef.current
    const synced = syncedRef.current
    if (!canvas || !synced || !colorData) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = devicePixelRatio || 1
    let cssW = canvas.getBoundingClientRect().width
    let cssH = canvas.getBoundingClientRect().height
    canvas.width = cssW * dpr
    canvas.height = cssH * dpr
    sizeRef.current = { w: cssW, h: cssH }

    // Build tiles at current pixel height
    buildTiles(Math.floor(cssH * dpr))

    const ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect()
      cssW = r.width
      cssH = r.height
      canvas.width = cssW * dpr
      canvas.height = cssH * dpr
      sizeRef.current = { w: cssW, h: cssH }
      // Rebuild tiles if height changed
      const newPxH = Math.floor(cssH * dpr)
      if (newPxH !== tileHRef.current) {
        buildTiles(newPxH)
      }
    })
    ro.observe(canvas)

    const totalBars = colorData.bars.length
    const barsPerSecond = colorData.sampleRate / colorData.hopSize

    function draw() {
      const currentTime = synced!.getCurrentTime()
      const duration = colorData!.duration
      const pxW = cssW * dpr
      const pxH = cssH * dpr

      ctx!.setTransform(1, 0, 0, 1, 0, 0)
      ctx!.clearRect(0, 0, pxW, pxH)

      const visibleBars = visibleSeconds * barsPerSecond
      const pxPerBar = pxW / visibleBars

      const centerBar = (currentTime / duration) * totalBars
      const startBarF = centerBar - visibleBars / 2
      const centerPx = pxW / 2

      // Draw tiles using drawImage — zero per-frame string allocations
      const brightTiles = brightTilesRef.current
      const dimTiles = dimTilesRef.current
      if (brightTiles.length > 0) {
        // For each visible bar range, figure out which tiles to draw
        const firstBar = Math.max(0, Math.floor(startBarF))
        const lastBar = Math.min(totalBars - 1, Math.ceil(startBarF + visibleBars))
        const firstTile = Math.floor(firstBar / TILE_WIDTH)
        const lastTile = Math.floor(lastBar / TILE_WIDTH)

        // The pixel position where bar 0 would be drawn
        const bar0X = -startBarF * pxPerBar

        // Playhead bar index (where bright/dim split happens)
        const playheadBar = centerBar

        for (let t = firstTile; t <= lastTile && t < brightTiles.length; t++) {
          const tileStartBar = t * TILE_WIDTH
          const tileEndBar = tileStartBar + brightTiles[t].width
          const tileX = bar0X + tileStartBar * pxPerBar

          // Determine bright/dim split within this tile
          const splitBar = Math.max(tileStartBar, Math.min(tileEndBar, playheadBar))
          const splitLocalBar = splitBar - tileStartBar

          // Draw dim portion (bars >= playhead)
          if (splitLocalBar < brightTiles[t].width) {
            const srcX = splitLocalBar
            const srcW = brightTiles[t].width - splitLocalBar
            const destX = tileX + splitLocalBar * pxPerBar
            const destW = srcW * pxPerBar
            ctx!.drawImage(dimTiles[t], srcX, 0, srcW, pxH, destX, 0, destW, pxH)
          }

          // Draw bright portion (bars < playhead)
          if (splitLocalBar > 0) {
            const srcW = splitLocalBar
            const destW = srcW * pxPerBar
            ctx!.drawImage(brightTiles[t], 0, 0, srcW, pxH, tileX, 0, destW, pxH)
          }
        }
      }

      // Playhead center line
      ctx!.fillStyle = 'rgba(255, 255, 255, 0.8)'
      ctx!.fillRect(centerPx - 1, 0, 2, pxH)

      rafRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      ro.disconnect()
    }
  // Note: isPlaying intentionally excluded — RAF loop runs continuously and
  // reads currentTime from syncedRef directly, so play/pause doesn't need
  // to tear down and rebuild tiles.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncedRef, colorData, trackIndex, visibleSeconds, buildTiles])

  const stopMomentum = useCallback(() => {
    if (momentumRef.current) {
      cancelAnimationFrame(momentumRef.current.raf)
      momentumRef.current = null
    }
  }, [])

  const handleDragStart = useCallback((clientX: number) => {
    const synced = syncedRef.current
    if (!synced) return
    stopMomentum()
    const now = performance.now()
    dragRef.current = { startX: clientX, startTime: synced.getCurrentTime(), lastX: clientX, lastTs: now, velocity: 0 }
  }, [syncedRef, stopMomentum])

  const handleDragMove = useCallback((clientX: number) => {
    const drag = dragRef.current
    const synced = syncedRef.current
    if (!drag || !synced) return
    const { w } = sizeRef.current
    if (w === 0) return
    const duration = synced.getDuration()
    if (!duration) return

    // Seek based on total drag offset
    const dx = drag.startX - clientX
    const dt = (dx / w) * visibleSeconds
    const newTime = Math.max(0, Math.min(duration, drag.startTime + dt))
    synced.seek(newTime / duration)

    // Track velocity (px/ms) with smoothing
    const now = performance.now()
    const elapsed = now - drag.lastTs
    if (elapsed > 0) {
      const instantV = (drag.lastX - clientX) / elapsed // px/ms, positive = seeking forward
      drag.velocity = drag.velocity * 0.6 + instantV * 0.4
    }
    drag.lastX = clientX
    drag.lastTs = now
  }, [syncedRef, visibleSeconds])

  const handleDragEnd = useCallback(() => {
    const drag = dragRef.current
    const synced = syncedRef.current
    if (!drag || !synced) { dragRef.current = null; return }

    const { w } = sizeRef.current
    const duration = synced.getDuration()
    // Only coast if there's meaningful velocity
    const vPxPerMs = drag.velocity
    dragRef.current = null
    if (!duration || w === 0 || Math.abs(vPxPerMs) < 0.05) return

    // Convert px/ms velocity to seconds/ms
    let vSecsPerMs = (vPxPerMs / w) * visibleSeconds
    const friction = 0.88 // per-frame multiplier

    const coast = () => {
      vSecsPerMs *= friction
      if (Math.abs(vSecsPerMs) < 0.00002) { momentumRef.current = null; return }
      const cur = synced.getCurrentTime()
      const dt = vSecsPerMs * 16 // ~16ms per frame
      const next = Math.max(0, Math.min(duration, cur + dt))
      synced.seek(next / duration)
      momentumRef.current!.raf = requestAnimationFrame(coast)
    }
    momentumRef.current = { velocity: vPxPerMs, raf: requestAnimationFrame(coast) }
  }, [syncedRef, visibleSeconds])

  return (
    <canvas
      ref={canvasRef}
      className="zoomed-waveform-canvas"
      onTouchStart={(e) => handleDragStart(e.touches[0].clientX)}
      onTouchMove={(e) => handleDragMove(e.touches[0].clientX)}
      onTouchEnd={handleDragEnd}
      onMouseDown={(e) => { handleDragStart(e.clientX); e.preventDefault() }}
      onMouseMove={(e) => { if (dragRef.current) handleDragMove(e.clientX) }}
      onMouseUp={handleDragEnd}
      onMouseLeave={handleDragEnd}
    />
  )
}
