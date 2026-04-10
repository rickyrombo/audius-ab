import { useEffect, useRef } from 'react'
import type { SyncedWaveforms } from '../lib/waveforms'

interface HotkeyOptions {
  activeIndex: number
  isPlaying: boolean
  duration: number
  currentTime: number
  bpms: number[]
  trackCount: number
  syncedRef: React.MutableRefObject<SyncedWaveforms | null>
  seek: (progress: number) => void
  play: () => void
  pause: () => void
  setIsPlaying: (playing: boolean) => void
  onToggleTrack: (index: number) => void
  /** Extra keydown handler for page-specific keys (e.g. "C" for comment). Return true to consume the event. */
  onExtraKey?: (e: KeyboardEvent) => boolean
}

export function useHotkeys(opts: HotkeyOptions) {
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    const FINE_NUDGE_SECS = 0.5
    const FF_INTERVAL_MS = 80
    const FF_SECS_PER_TICK = 0.5
    const HOLD_THRESHOLD_MS = 300
    const FF_SHIFT_MULTIPLIER = 4

    let holdTimer: ReturnType<typeof setTimeout> | null = null
    let ffInterval: ReturnType<typeof setInterval> | null = null
    let didHold = false
    let wasShiftSeek = false
    let shiftHeld = false

    function fourBeatsSecs(): number {
      const bpm = optsRef.current.bpms[optsRef.current.activeIndex] || 120
      return (60 / bpm) * 4
    }

    function seekRelative(deltaSecs: number) {
      const o = optsRef.current
      const dur = o.duration
      if (dur <= 0) return
      const cur = o.syncedRef.current?.getCurrentTime() ?? o.currentTime
      const newTime = Math.max(0, Math.min(dur, cur + deltaSecs))
      o.seek(newTime / dur)
    }

    function startFastSeek(dir: number) {
      if (ffInterval) return
      didHold = true
      ffInterval = setInterval(() => {
        seekRelative(dir * FF_SECS_PER_TICK * (shiftHeld ? FF_SHIFT_MULTIPLIER : 1))
      }, FF_INTERVAL_MS)
    }

    function stopFastSeek() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null }
      if (ffInterval) { clearInterval(ffInterval); ffInterval = null }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Shift') { shiftHeld = true; return }

      if (
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLInputElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) return

      const o = optsRef.current

      // Let page-specific handler try first
      if (o.onExtraKey?.(e)) return

      if (e.key === ' ') {
        e.preventDefault()
        if (o.isPlaying) { o.pause(); o.setIsPlaying(false) }
        else { o.play(); o.setIsPlaying(true) }
        return
      }

      const numIdx = ['1', '2'].indexOf(e.key)
      if (numIdx !== -1 && numIdx < o.trackCount) {
        o.onToggleTrack(numIdx)
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = Math.max(0, o.activeIndex - 1)
        if (prev !== o.activeIndex) o.onToggleTrack(prev)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = Math.min(o.trackCount - 1, o.activeIndex + 1)
        if (next !== o.activeIndex) o.onToggleTrack(next)
        return
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        if (e.repeat) return
        const dir = e.key === 'ArrowRight' ? 1 : -1
        didHold = false
        wasShiftSeek = e.shiftKey
        shiftHeld = e.shiftKey
        holdTimer = setTimeout(() => startFastSeek(dir), HOLD_THRESHOLD_MS)
        return
      }
    }

    function handleKeyUp(e: KeyboardEvent) {
      if (e.key === 'Shift') { shiftHeld = false; return }

      if (
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLInputElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) return

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const dir = e.key === 'ArrowRight' ? 1 : -1
        stopFastSeek()
        if (!didHold) {
          if (wasShiftSeek) seekRelative(dir * fourBeatsSecs())
          else seekRelative(dir * FINE_NUDGE_SECS)
        }
        didHold = false
        wasShiftSeek = false
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      stopFastSeek()
    }
  }, [])
}
