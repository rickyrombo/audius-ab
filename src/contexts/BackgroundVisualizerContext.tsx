import { createContext, useContext, useRef, useCallback, type ReactNode } from 'react'

interface BackgroundVisualizerState {
  setBpm: (bpm: number) => void
  setIsPlaying: (playing: boolean) => void
  bpmRef: React.MutableRefObject<number>
  isPlayingRef: React.MutableRefObject<boolean>
}

const BackgroundVisualizerContext = createContext<BackgroundVisualizerState | null>(null)

export function BackgroundVisualizerProvider({ children }: { children: ReactNode }) {
  const bpmRef = useRef(120)
  const isPlayingRef = useRef(false)

  const setBpm = useCallback((bpm: number) => { bpmRef.current = bpm }, [])
  const setIsPlaying = useCallback((playing: boolean) => { isPlayingRef.current = playing }, [])

  return (
    <BackgroundVisualizerContext.Provider value={{ setBpm, setIsPlaying, bpmRef, isPlayingRef }}>
      {children}
    </BackgroundVisualizerContext.Provider>
  )
}

export function useBackgroundVisualizer() {
  const ctx = useContext(BackgroundVisualizerContext)
  if (!ctx) throw new Error('useBackgroundVisualizer must be used within BackgroundVisualizerProvider')
  return ctx
}
