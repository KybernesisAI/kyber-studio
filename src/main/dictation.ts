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
 * What to tell a Windows user when the native speech binding will not load.
 *
 * MEASURED in KYB-627: the shipped `onnxruntime.dll` and
 * `onnxruntime_binding.node` are linked with MSVC toolset 14.44 and load-time
 * import `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll`, `MSVCP140.dll` and
 * `MSVCP140_1.dll`. The MSVC runtime is forward compatible but not backward, so
 * an older runtime fails at INITIALISATION rather than at load.
 *
 * The installer closes the common case (KYB-627) but not every case: an imaged
 * machine, a copied `win-unpacked` folder, a runtime rolled back after
 * installation, or a future `onnxruntime-node` bump that raises the floor all
 * reach here with the prerequisite having done nothing wrong.
 */
const VC_REDIST_GUIDANCE =
  "Dictation needs the Microsoft Visual C++ 2015-2022 x64 Redistributable " +
  '(version 14.44 or newer). Install it from Microsoft\'s "Latest supported ' +
  'Visual C++ Redistributable downloads" page and try again.';

/**
 * Did this failure come from the native binding failing to load?
 *
 * @remarks
 * **The detection deliberately does not read the message text.** Node reports
 * this as the Win32 string for `ERROR_DLL_INIT_FAILED` (1114), which is
 * LOCALISED — matching "initialization routine failed" would work on an English
 * machine and silently stop working on a German one, which is the worst
 * possible failure mode for a diagnostic.
 *
 * So the primary signal is `error.code === "ERR_DLOPEN_FAILED"`, which node
 * sets for every native-module load failure on every platform and in every
 * locale. MEASURED that it survives the route this actually takes: the dynamic
 * `import("@huggingface/transformers")` in `load()` reaches `onnxruntime-node`
 * through a static ESM import, which `require`s the `.node` file — and the
 * error arrives with `code` intact and no `cause` wrapper.
 *
 * The binding's own filename is the fallback, for the day a library does wrap
 * it. That is not localised either. The `cause` chain is walked, with a hop
 * limit so a cyclic chain cannot hang the handler.
 *
 * Deliberately NOT distinguished: a MISSING DLL (Win32 126) from a FAILED
 * INITIALISATION (1114). Telling those apart means parsing the localised text,
 * and the remedy is the same sentence either way.
 */
function isNativeBindingFailure(error: unknown): boolean {
  let link: unknown = error;
  for (let hops = 0; link instanceof Error && hops < 8; hops += 1) {
    if ((link as { code?: unknown }).code === "ERR_DLOPEN_FAILED") return true;
    if (/onnxruntime_binding\.node/i.test(link.message)) return true;
    link = (link as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The message a person should see for a failed transcription.
 *
 * Exported for the tests, which is the only way to demonstrate the
 * discrimination the ticket asks for rather than assert it.
 *
 * @param platform - Defaults to the running platform; a parameter so the
 * non-Windows behaviour can be measured on a Linux CI runner.
 */
export function dictationErrorMessage(error: unknown, platform: string = process.platform): string {
  // Windows only. On macOS and Linux a native load failure means something
  // else entirely, and the redistributable does not exist to install.
  if (platform === "win32" && isNativeBindingFailure(error)) return VC_REDIST_GUIDANCE;
  return error instanceof Error ? error.message : String(error);
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
    // Logged in full, deliberately: the raw text names the binding and carries
    // the absolute path, which is what somebody debugging this needs and
    // exactly what should not reach the UI. `error` rather than `warn` — this
    // one ends with dictation not working at all.
    console.error("[dictation] transcription failed:", error);
    return { error: dictationErrorMessage(error) };
  }
}

/**
 * Load the model without transcribing.
 *
 * Called when the window opens so the first dictation is not the one that pays
 * for loading. Logs failure so a broken build leaves evidence, but does not
 * surface errors until the user actually invokes dictation.
 */
export function warmUp(): void {
  if (!dictationAvailable()) return;
  void load().catch((error) => {
    console.warn("[dictation] warmup failed:", error.message ?? String(error));
  });
}
