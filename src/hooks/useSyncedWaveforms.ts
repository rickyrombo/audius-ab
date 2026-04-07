import { useEffect, useRef, useState } from "react";
import { SyncedWaveforms } from "../lib/waveforms";
import type { WaveformColorData } from "../lib/waveformAnalysis";

export function useSyncedWaveforms(
  streamUrls: string[],
  trackIds: string[],
  onSeekWhilePaused?: (time: number) => void,
  onFinish?: () => void,
) {
  const syncedRef = useRef<SyncedWaveforms | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [trackDurations, setTrackDurations] = useState<number[]>([]);
  const [colorData, setColorData] = useState<(WaveformColorData | null)[]>([]);
  const [bpms, setBpms] = useState<number[]>([]);
  const seekWhilePausedRef = useRef(onSeekWhilePaused);
  seekWhilePausedRef.current = onSeekWhilePaused;
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;

  const urlKey = streamUrls.join(",");

  useEffect(() => {
    if (!streamUrls.length) return;

    const synced = new SyncedWaveforms();
    syncedRef.current = synced;
    setIsReady(false);
    setCurrentTime(0);
    setDuration(0);
    setColorData([]);
    setBpms([]);

    synced.onReady(() => {
      setIsReady(true);
      setDuration(synced.getDuration());
      setTrackDurations(synced.getTrackDurations());
      setColorData(streamUrls.map((_, i) => synced.getColorData(i)));
      const detectedBpms = streamUrls.map((_, i) => synced.getBPM(i));
      setBpms(detectedBpms);
      console.log('[BPM]', detectedBpms.map((bpm, i) => `Track ${i}: ${bpm} BPM`).join(', '));
    });
    let lastStateUpdate = 0;
    synced.onTimeUpdate((t, d) => {
      const now = performance.now();
      if (now - lastStateUpdate > 250) {
        lastStateUpdate = now;
        setCurrentTime(t);
        setDuration(d);
      }
    });
    synced.onSeekWhilePaused((t) => {
      seekWhilePausedRef.current?.(t);
    });
    synced.onFinish(() => {
      finishRef.current?.();
    });
    synced.load(streamUrls, trackIds);

    return () => {
      synced.destroy();
      syncedRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey]);

  return {
    isReady,
    currentTime,
    duration,
    trackDurations,
    colorData,
    bpms,
    play: () => syncedRef.current?.play(),
    pause: () => syncedRef.current?.pause(),
    seek: (progress: number) => syncedRef.current?.seek(progress),
    setActive: (i: number) => syncedRef.current?.setActiveIndex(i),
    syncedRef,
  };
}
