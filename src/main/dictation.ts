import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/**
 * Speech to text, on this machine, with nothing installed.
 *
 * @remarks
 * The model ships inside the app (see `scripts/fetch-speech-model.mjs`) and
 * runs here in the main process. Two consequences worth stating plainly,
 * because both are promises to the person using it:
 *
 * **The audio never leaves the machine.** Dictation captures whatever is
 * audible — a colleague on a call, a client in the room — and it captures it
 * before anyone has decided the recording was worth keeping. Sending that to a
 * service to be turned into text is a commitment nobody wants to explain to a
 * security review. Here there is nothing to explain.
 *
 * **It works offline and needs no key.** A client installs the app and dictates.
 * No account, no package manager, no first-run download that fails behind a
 * corporate proxy.
 *
 * The model is loaded lazily and kept. First use pays a second or two; after
 * that a short phrase transcribes in well under a second, which is the
 * difference between a feature people use and one they try once.
 */

/** Loaded once, then reused. `null` until the first transcription is asked for. */
let transcriber: unknown = null;
let loading: Promise<unknown> | null = null;

/** Where the packaged model sits, in development and in a built app. */
function modelRoot(): string {
  // In a packaged app, `resources/` is beside the app bundle's Resources; in
  // development it is the repo folder. Checking both means dictation behaves
  // the same in `npm run dev` as it does in the .dmg, which is where a
  // difference would be discovered far too late.
  const packaged = join(process.resourcesPath ?? "", "resources", "models");
  if (existsSync(packaged)) return packaged;
  const packagedFlat = join(process.resourcesPath ?? "", "models");
  if (existsSync(packagedFlat)) return packagedFlat;
  return join(app.getAppPath(), "resources", "models");
}

export function dictationAvailable(): boolean {
  return existsSync(join(modelRoot(), "Xenova", "whisper-base.en"));
}

async function load(): Promise<unknown> {
  if (transcriber) return transcriber;
  if (loading) return loading;
  loading = (async () => {
    const { env, pipeline } = await import("@huggingface/transformers");
    // Local only, deliberately. Left to its default the library would reach out
    // to a model host on first use — which is exactly the surprise this design
    // exists to avoid, and it would fail on a machine with no internet while
    // appearing to be a broken microphone.
    env.allowRemoteModels = false;
    env.localModelPath = modelRoot();
    transcriber = await pipeline("automatic-speech-recognition", "Xenova/whisper-base.en", {
      dtype: "q8",
    });
    return transcriber;
  })();
  return loading;
}

export interface TranscriptionResult {
  text?: string;
  error?: string;
}

/**
 * Turn recorded audio into text.
 *
 * @param samples - Mono PCM at 16 kHz, which is what the model expects. The
 * renderer resamples before sending, because the browser records at the
 * device's rate and a mismatch does not error — it transcribes gibberish,
 * which reads as a bad model rather than a wrong sample rate.
 */
export async function transcribe(samples: Float32Array): Promise<TranscriptionResult> {
  if (samples.length === 0) return { error: "Nothing was recorded." };
  if (!dictationAvailable()) {
    return { error: "The speech model is missing from this build." };
  }
  try {
    const pipe = (await load()) as (audio: Float32Array, options: unknown) => Promise<{ text?: string }>;
    // No `language` or `task`: this is an English-only model, and passing
    // either makes it refuse outright — it only accepts them from a
    // multilingual checkpoint. The parameters look harmless and are not.
    const output = await pipe(samples, {
      // Dictation is one utterance, not a recording to be segmented.
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const text = (output?.text ?? "").trim();
    // Whisper emits bracketed labels for non-speech — [BLANK_AUDIO], [MUSIC] —
    // and putting those in someone's message box is worse than putting nothing.
    const cleaned = text.replace(/\[[A-Z_ ]+\]/g, "").trim();
    return cleaned ? { text: cleaned } : { error: "Nothing was said." };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/**
 * Load the model without transcribing.
 *
 * Called when the window opens so the first dictation is not the one that pays
 * for loading. Failure is silent by design: this is an optimisation, and an
 * error here would be reported to somebody who has not asked for anything.
 */
export function warmUp(): void {
  if (!dictationAvailable()) return;
  void load().catch(() => undefined);
}
