import { analyzeWaveformColors, analyzeLoudness, detectBPM, type WaveformColorData, type LoudnessStats } from "./waveformAnalysis";
import { getCachedAudio, setCachedAudio, getCachedWaveform, setCachedWaveform } from "./audioCache";
import { fetchWithMirrors } from "./streamUrl";

type ReadyCallback = () => void;
type TimeUpdateCallback = (time: number, duration: number) => void;
type SeekCallback = (time: number) => void;

export class SyncedWaveforms {
  private audioCtx: AudioContext;
  private audioBuffers: AudioBuffer[] = [];
  private colorData: WaveformColorData[] = [];
  private bpms: number[] = [];
  private loudnessStats: LoudnessStats[] = [];
  private gainNodes: GainNode[] = [];
  private sources: AudioBufferSourceNode[] = [];
  private activeIndex = 0;
  private isPlaying = false;
  private startContextTime = 0;
  private startOffset = 0;
  private rafId: number | null = null;
  private readyCb: ReadyCallback | null = null;
  private timeUpdateCb: TimeUpdateCallback | null = null;
  private seekWhilePausedCb: SeekCallback | null = null;
  private finishCb: ReadyCallback | null = null;
  private destroyed = false;

  // Analysis nodes (main output)
  private analyserNode: AnalyserNode;
  private analyserL: AnalyserNode;
  private analyserR: AnalyserNode;
  private splitter: ChannelSplitterNode;
  private mergerToDestination: ChannelMergerNode;

  // Per-track analysis nodes (always active regardless of gain)
  private trackAnalysers: AnalyserNode[] = [];
  private trackSplitters: ChannelSplitterNode[] = [];
  private trackAnalysersL: AnalyserNode[] = [];
  private trackAnalysersR: AnalyserNode[] = [];
  // K-weighted analysers for true LUFS measurement (ITU-R BS.1770)
  private trackKWeightedAnalysers: AnalyserNode[] = [];
  private kWeightShelf: BiquadFilterNode[] = [];
  private kWeightHP: BiquadFilterNode[] = [];
  private silentGain: GainNode;

  constructor() {
    this.audioCtx = new AudioContext();

    // Main analyser on the summed output
    this.analyserNode = this.audioCtx.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.analyserNode.smoothingTimeConstant = 0.8;

    // Stereo split for L/R analysis (panning/width)
    this.splitter = this.audioCtx.createChannelSplitter(2);
    this.mergerToDestination = this.audioCtx.createChannelMerger(2);

    this.analyserL = this.audioCtx.createAnalyser();
    this.analyserL.fftSize = 256;
    this.analyserR = this.audioCtx.createAnalyser();
    this.analyserR.fftSize = 256;

    // analyserNode -> splitter -> L/R analysers -> merger -> destination
    this.analyserNode.connect(this.splitter);
    this.splitter.connect(this.analyserL, 0);
    this.splitter.connect(this.analyserR, 1);
    this.analyserL.connect(this.mergerToDestination, 0, 0);
    this.analyserR.connect(this.mergerToDestination, 0, 1);
    this.mergerToDestination.connect(this.audioCtx.destination);

    // Silent gain node for per-track analysis (keeps nodes processing without audible output)
    this.silentGain = this.audioCtx.createGain();
    this.silentGain.gain.value = 0;
    this.silentGain.connect(this.audioCtx.destination);
  }

  async load(streamUrlSets: string[][], trackIds: string[]): Promise<void> {
    if (this.destroyed) return;

    // Fetch + decode all tracks in parallel (with cache by track ID)
    const buffers = await Promise.all(
      streamUrlSets.map(async (urls, i) => {
        const cacheKey = trackIds[i];
        let ab = await getCachedAudio(cacheKey);
        if (!ab) {
          const resp = await fetchWithMirrors(urls);
          ab = await resp.arrayBuffer();
          setCachedAudio(cacheKey, ab.slice(0));
        }
        return this.audioCtx.decodeAudioData(ab);
      }),
    );

    if (this.destroyed) return;

    this.audioBuffers = buffers;

    // Create gain nodes — route through analyser instead of directly to destination
    this.gainNodes = buffers.map((_, i) => {
      const gain = this.audioCtx.createGain();
      gain.gain.value = i === this.activeIndex ? 1 : 0;
      gain.connect(this.analyserNode);
      return gain;
    });

    // Create per-track analysis chains (always active regardless of gain)
    this.trackAnalysers = buffers.map(() => {
      const a = this.audioCtx.createAnalyser();
      a.fftSize = 8192;
      a.smoothingTimeConstant = 0.75;
      return a;
    });
    this.trackSplitters = buffers.map(() =>
      this.audioCtx.createChannelSplitter(2),
    );
    this.trackAnalysersL = buffers.map(() => {
      const a = this.audioCtx.createAnalyser();
      a.fftSize = 256;
      return a;
    });
    this.trackAnalysersR = buffers.map(() => {
      const a = this.audioCtx.createAnalyser();
      a.fftSize = 256;
      return a;
    });

    // K-weighted analysers for LUFS (ITU-R BS.1770 K-weighting)
    // Stage 1: High-shelf boost (+4dB above ~1.5kHz) — models head/ear acoustics
    // Stage 2: High-pass (RLB weighting) — rolls off below ~60Hz
    this.kWeightShelf = buffers.map(() => {
      const f = this.audioCtx.createBiquadFilter();
      f.type = 'highshelf';
      f.frequency.value = 1681.974;  // ITU-R BS.1770 specified
      f.gain.value = 3.999;          // +4dB
      f.Q.value = 0.7071;
      return f;
    });
    this.kWeightHP = buffers.map(() => {
      const f = this.audioCtx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 38.135;    // ITU-R BS.1770 RLB weighting
      f.Q.value = 0.5003;
      return f;
    });
    this.trackKWeightedAnalysers = buffers.map(() => {
      const a = this.audioCtx.createAnalyser();
      a.fftSize = 2048;
      a.smoothingTimeConstant = 0;  // No smoothing — we need raw samples
      return a;
    });

    // Wire per-track analysis: trackAnalyser -> splitter -> L/R analysers -> silentGain
    //                          trackAnalyser -> shelf -> HP -> kWeightedAnalyser -> silentGain
    for (let i = 0; i < buffers.length; i++) {
      this.trackAnalysers[i].connect(this.trackSplitters[i]);
      this.trackSplitters[i].connect(this.trackAnalysersL[i], 0);
      this.trackSplitters[i].connect(this.trackAnalysersR[i], 1);
      this.trackAnalysersL[i].connect(this.silentGain);
      this.trackAnalysersR[i].connect(this.silentGain);

      // K-weighted chain
      this.trackAnalysers[i].connect(this.kWeightShelf[i]);
      this.kWeightShelf[i].connect(this.kWeightHP[i]);
      this.kWeightHP[i].connect(this.trackKWeightedAnalysers[i]);
      this.trackKWeightedAnalysers[i].connect(this.silentGain);
    }

    // Analyze waveform colors for each track (with cache by track ID)
    this.colorData = await Promise.all(
      buffers.map(async (buf, i) => {
        const cacheKey = trackIds[i];
        const cached = await getCachedWaveform(cacheKey);
        if (cached) return cached;
        const data = analyzeWaveformColors(buf);
        setCachedWaveform(cacheKey, data);
        return data;
      }),
    );

    // BPM detection and loudness analysis for each track
    this.bpms = buffers.map((buf) => detectBPM(buf));
    this.loudnessStats = buffers.map((buf) => analyzeLoudness(buf));

    this.readyCb?.();
  }

  play(): void {
    if (this.isPlaying || !this.audioBuffers.length) return;
    // If at the end, restart from the beginning
    const dur = this.getDuration();
    if (dur > 0 && this.startOffset >= dur) {
      this.startOffset = 0;
    }
    if (this.audioCtx.state === "suspended") {
      this.audioCtx.resume();
    }
    this._createAndStartSources(this.startOffset);
    this.isPlaying = true;
    this._startRaf();
  }

  pause(): void {
    if (!this.isPlaying) return;
    this.startOffset = this._getCurrentTime();
    this._stopSources();
    this.isPlaying = false;
    this._stopRaf();
  }

  seek(progress: number): void {
    const duration = this.getDuration();
    if (!duration) return;
    const offset = progress * duration;
    const wasPlaying = this.isPlaying;

    if (wasPlaying) {
      this._stopSources();
      this.isPlaying = false;
    }

    this.startOffset = offset;

    if (wasPlaying) {
      if (this.audioCtx.state === "suspended") {
        this.audioCtx.resume();
      }
      this._createAndStartSources(offset);
      this.isPlaying = true;
      this._stopRaf();
      this._startRaf();
    } else {
      // Fire time update so React state stays in sync while paused
      this.timeUpdateCb?.(this.startOffset, this.getDuration());
      this.seekWhilePausedCb?.(this.startOffset);
    }
  }

  setActiveIndex(i: number): void {
    this.activeIndex = i;
    this.gainNodes.forEach((gain, idx) => {
      gain.gain.value = idx === i ? 1 : 0;
    });
  }

  getCurrentTime(): number {
    return this._getCurrentTime();
  }

  getDuration(): number {
    if (!this.audioBuffers.length) return 0;
    return Math.max(...this.audioBuffers.map((b) => b.duration));
  }

  getTrackDurations(): number[] {
    return this.audioBuffers.map((b) => b.duration);
  }

  getAnalyser(): AnalyserNode {
    return this.analyserNode;
  }

  getAnalyserL(): AnalyserNode {
    return this.analyserL;
  }

  getAnalyserR(): AnalyserNode {
    return this.analyserR;
  }

  getTrackAnalyser(i: number): AnalyserNode {
    return this.trackAnalysers[i];
  }

  getTrackAnalyserL(i: number): AnalyserNode {
    return this.trackAnalysersL[i];
  }

  getTrackAnalyserR(i: number): AnalyserNode {
    return this.trackAnalysersR[i];
  }

  getTrackKWeightedAnalyser(i: number): AnalyserNode {
    return this.trackKWeightedAnalysers[i];
  }

  getSampleRate(): number {
    return this.audioCtx.sampleRate;
  }

  getColorData(i: number): WaveformColorData | null {
    return this.colorData[i] ?? null;
  }

  getBPM(i: number): number {
    return this.bpms[i] ?? 120;
  }

  getLoudnessStats(i: number): LoudnessStats | null {
    return this.loudnessStats[i] ?? null;
  }

  getProgress(): number {
    const dur = this.getDuration();
    if (dur <= 0) return 0;
    return Math.min(this._getCurrentTime() / dur, 1);
  }

  onReady(cb: ReadyCallback): void {
    this.readyCb = cb;
  }

  onTimeUpdate(cb: TimeUpdateCallback): void {
    this.timeUpdateCb = cb;
  }

  onSeekWhilePaused(cb: SeekCallback): void {
    this.seekWhilePausedCb = cb;
  }

  onFinish(cb: ReadyCallback): void {
    this.finishCb = cb;
  }

  destroy(): void {
    this.destroyed = true;
    this._stopRaf();
    this._stopSources();
    try {
      this.audioCtx.close();
    } catch {
      /* ignore */
    }
    this.gainNodes = [];
    this.audioBuffers = [];
    this.colorData = [];
    this.bpms = [];
    this.loudnessStats = [];
    this.trackAnalysers = [];
    this.trackSplitters = [];
    this.trackAnalysersL = [];
    this.trackAnalysersR = [];
    this.trackKWeightedAnalysers = [];
    this.kWeightShelf = [];
    this.kWeightHP = [];
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _getCurrentTime(): number {
    if (!this.isPlaying) return this.startOffset;
    const elapsed = this.audioCtx.currentTime - this.startContextTime;
    const t = this.startOffset + elapsed;
    const duration = this.getDuration();
    return duration ? Math.min(t, duration) : t;
  }

  private _createAndStartSources(offset: number): void {
    const startAt = this.audioCtx.currentTime;
    this.startContextTime = startAt;
    let endedCount = 0;
    const totalSources = this.audioBuffers.length;
    this.sources = this.audioBuffers.map((buf, i) => {
      const src = this.audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gainNodes[i]);
      // Also connect to per-track analyser (always active)
      if (this.trackAnalysers[i]) {
        src.connect(this.trackAnalysers[i]);
      }
      src.start(startAt, offset);
      src.onended = () => {
        endedCount++;
        if (this.isPlaying && endedCount >= totalSources) {
          // All sources finished — stop at end
          this.startOffset = this.getDuration();
          this.isPlaying = false;
          this._stopRaf();
          this.timeUpdateCb?.(this.startOffset, this.getDuration());
          this.finishCb?.();
        }
      };
      return src;
    });
  }

  private _stopSources(): void {
    this.sources.forEach((src) => {
      src.onended = null;
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    });
    this.sources = [];
  }

  private _startRaf(): void {
    const tick = () => {
      if (!this.isPlaying || this.destroyed) return;
      const t = this._getCurrentTime();
      const duration = this.getDuration();
      this.timeUpdateCb?.(t, duration);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private _stopRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

}
