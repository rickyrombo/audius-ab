import WaveSurfer from "wavesurfer.js";

type ReadyCallback = () => void;
type TimeUpdateCallback = (time: number, duration: number) => void;

export class SyncedWaveforms {
  private audioCtx: AudioContext;
  private containers: HTMLElement[];
  private audioBuffers: AudioBuffer[] = [];
  private gainNodes: GainNode[] = [];
  private sources: AudioBufferSourceNode[] = [];
  private wavesurfers: WaveSurfer[] = [];
  private activeIndex = 0;
  private isPlaying = false;
  private startContextTime = 0;
  private startOffset = 0;
  private rafId: number | null = null;
  private readyCb: ReadyCallback | null = null;
  private timeUpdateCb: TimeUpdateCallback | null = null;
  private destroyed = false;

  // Analysis nodes
  private analyserNode: AnalyserNode;
  private analyserL: AnalyserNode;
  private analyserR: AnalyserNode;
  private splitter: ChannelSplitterNode;
  private mergerToDestination: ChannelMergerNode;

  constructor(containers: HTMLElement[]) {
    this.containers = containers;
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
  }

  async load(streamUrls: string[], preloadedPeaks?: number[][]): Promise<void> {
    if (this.destroyed) return;

    // Fetch + decode all tracks in parallel
    const buffers = await Promise.all(
      streamUrls.map(async (url) => {
        const resp = await fetch(url);
        const ab = await resp.arrayBuffer();
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

    // Create WaveSurfer instances (visualization only)
    const maxDuration = Math.max(...buffers.map((b) => b.duration));
    const totalBars = 800;
    this.wavesurfers = buffers.map((buf, i) => {
      const rawPeaks =
        preloadedPeaks?.[i] ?? this._computePeaks(buf, totalBars);
      // Pad shorter tracks with zeros so waveform width is proportional to duration
      const ratio = buf.duration / maxDuration;
      const activeBars = Math.round(totalBars * ratio);
      const scaledPeaks = new Array(totalBars).fill(0);
      for (let j = 0; j < activeBars; j++) {
        scaledPeaks[j] =
          rawPeaks[Math.round((j * rawPeaks.length) / activeBars)] ?? 0;
      }
      const ws = WaveSurfer.create({
        container: this.containers[i],
        waveColor: "#444",
        progressColor: "#cc0000",
        cursorColor: "#cc0000",
        cursorWidth: 2,
        height: 60,
        barWidth: 2,
        barGap: 1,
        barRadius: 1,
        interact: true,
        peaks: [scaledPeaks],
        duration: maxDuration,
      });

      // Route waveform clicks to seek all tracks
      ws.on("interaction", (time: number) => {
        const duration = this.getDuration();
        if (duration > 0) {
          this.seek(time / duration);
        }
      });

      return ws;
    });

    this.readyCb?.();
  }

  play(): void {
    if (this.isPlaying || !this.audioBuffers.length) return;
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

    // Update all WaveSurfer playheads
    this.wavesurfers.forEach((ws) => {
      ws.seekTo(progress);
    });

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

  getAnalyser(): AnalyserNode {
    return this.analyserNode;
  }

  getAnalyserL(): AnalyserNode {
    return this.analyserL;
  }

  getAnalyserR(): AnalyserNode {
    return this.analyserR;
  }

  getSampleRate(): number {
    return this.audioCtx.sampleRate;
  }

  onReady(cb: ReadyCallback): void {
    this.readyCb = cb;
  }

  onTimeUpdate(cb: TimeUpdateCallback): void {
    this.timeUpdateCb = cb;
  }

  destroy(): void {
    this.destroyed = true;
    this._stopRaf();
    this._stopSources();
    this.wavesurfers.forEach((ws) => {
      try {
        ws.destroy();
      } catch {
        /* ignore */
      }
    });
    try {
      this.audioCtx.close();
    } catch {
      /* ignore */
    }
    this.gainNodes = [];
    this.audioBuffers = [];
    this.wavesurfers = [];
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
    this.sources = this.audioBuffers.map((buf, i) => {
      const src = this.audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gainNodes[i]);
      src.start(startAt, offset);
      src.onended = () => {
        if (this.isPlaying && i === 0) {
          // All done — stop at end
          this.startOffset = this.getDuration();
          this.isPlaying = false;
          this._stopRaf();
          // Update waveform cursors to end
          this.wavesurfers.forEach((ws) => ws.seekTo(1));
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
      if (duration > 0) {
        const progress = t / duration;
        this.wavesurfers.forEach((ws) => {
          ws.seekTo(Math.min(progress, 1));
        });
      }
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

  private _computePeaks(buffer: AudioBuffer, length: number): number[] {
    const channels = buffer.numberOfChannels;
    const totalSamples = buffer.length;
    const samplesPerPeak = Math.floor(totalSamples / length);
    const peaks: number[] = new Array(length).fill(0);

    for (let ch = 0; ch < channels; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        let max = 0;
        const start = i * samplesPerPeak;
        const end = Math.min(start + samplesPerPeak, totalSamples);
        for (let j = start; j < end; j++) {
          const abs = Math.abs(data[j]);
          if (abs > max) max = abs;
        }
        if (max > peaks[i]) peaks[i] = max;
      }
    }

    return peaks;
  }
}
