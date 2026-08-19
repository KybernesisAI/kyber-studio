/**
 * Recording speech, and only while somebody is holding the button.
 *
 * @remarks
 * The rule this module exists to enforce: **no audio is captured unless the
 * user is actively holding the control.** Not "we discard it afterwards", not
 * "we only send it when you release" — the microphone is not open at all
 * otherwise, and the moment recording stops every track is stopped so the
 * operating system's own recording indicator goes out.
 *
 * That is a deliberate choice against the easier design. Always-listening with
 * a wake word is a better demo and a worse product: in an office it is a
 * support burden and a trust problem, and the first time someone's private
 * conversation appears in a text box the feature is finished, whatever the
 * privacy policy says.
 */

/** What the model wants. The device records at its own rate; we convert. */
const TARGET_SAMPLE_RATE = 16_000;

/** Below this, a "recording" was a mis-click rather than speech. */
const MIN_DURATION_MS = 250;

export interface Recorder {
  /** Stop, and return the audio as mono 16 kHz samples. Empty when too short. */
  stop(): Promise<Float32Array>;
  /** Stop and discard. For Escape, and for anything that goes wrong. */
  cancel(): void;
  /** 0–1, for showing that the microphone is genuinely hearing something. */
  level(): number;
}

/**
 * Open the microphone and start recording.
 *
 * @throws When permission is refused, so the caller can say so plainly rather
 * than showing a control that silently does nothing.
 */
export async function record(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.start();
  const startedAt = Date.now();

  // A level meter, so the UI can show the microphone hearing something. Without
  // it, a muted input or the wrong device looks exactly like a person who has
  // not spoken yet — and they find out only when the transcript comes back
  // empty.
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const buffer = new Uint8Array(analyser.frequencyBinCount);

  const shutDown = (): void => {
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => undefined);
  };

  return {
    level() {
      analyser.getByteTimeDomainData(buffer);
      let peak = 0;
      for (const value of buffer) peak = Math.max(peak, Math.abs(value - 128) / 128);
      return peak;
    },
    cancel() {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } finally {
        shutDown();
      }
    },
    async stop() {
      const tooShort = Date.now() - startedAt < MIN_DURATION_MS;
      const finished = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      if (recorder.state !== "inactive") recorder.stop();
      await finished;
      shutDown();
      if (tooShort) return new Float32Array(0);
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      return await toMono16k(await blob.arrayBuffer());
    },
  };
}

/**
 * Decode recorded audio and resample it to mono 16 kHz.
 *
 * @remarks
 * The resampling is not optional and its absence does not error. A model fed
 * 48 kHz audio while expecting 16 kHz transcribes something — fluent,
 * confident, and unrelated to what was said — which reads as a bad model rather
 * than a wrong sample rate. `OfflineAudioContext` does the conversion properly
 * rather than by dropping samples.
 */
async function toMono16k(encoded: ArrayBuffer): Promise<Float32Array> {
  const decodeContext = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeContext.decodeAudioData(encoded);
  } finally {
    void decodeContext.close().catch(() => undefined);
  }

  const frames = Math.max(1, Math.round((decoded.duration * TARGET_SAMPLE_RATE)));
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}
