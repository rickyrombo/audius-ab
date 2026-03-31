import { useEffect, useRef, useState } from "react";
import { SyncedWaveforms } from "../lib/waveforms";

export function useSyncedWaveforms(
  containerRefs: React.MutableRefObject<(HTMLDivElement | null)[]>,
  streamUrls: string[],
  onSeekWhilePaused?: (time: number) => void,
  onFinish?: () => void,
) {
  const syncedRef = useRef<SyncedWaveforms | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [trackDurations, setTrackDurations] = useState<number[]>([]);
  const seekWhilePausedRef = useRef(onSeekWhilePaused);
  seekWhilePausedRef.current = onSeekWhilePaused;
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;

  const urlKey = streamUrls.join(",");

  useEffect(() => {
    if (!streamUrls.length) return;
    const containers = containerRefs.current.filter(
      (el): el is HTMLDivElement => el !== null,
    );
    if (containers.length !== streamUrls.length) return;

    const synced = new SyncedWaveforms(containers);
    syncedRef.current = synced;
    setIsReady(false);
    setCurrentTime(0);
    setDuration(0);

    synced.onReady(() => {
      setIsReady(true);
      setDuration(synced.getDuration());
      setTrackDurations(synced.getTrackDurations());
    });
    synced.onTimeUpdate((t, d) => {
      setCurrentTime(t);
      setDuration(d);
    });
    synced.onSeekWhilePaused((t) => {
      seekWhilePausedRef.current?.(t);
    });
    synced.onFinish(() => {
      finishRef.current?.();
    });
    synced.load(streamUrls);

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
    play: () => syncedRef.current?.play(),
    pause: () => syncedRef.current?.pause(),
    seek: (progress: number) => syncedRef.current?.seek(progress),
    setActive: (i: number) => syncedRef.current?.setActiveIndex(i),
    syncedRef,
  };
}
