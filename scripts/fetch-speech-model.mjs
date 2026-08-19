#!/usr/bin/env node
/**
 * Fetch the speech model into resources/ so it ships inside the app.
 *
 * @remarks
 * Dictation must work on a client's machine with nothing installed and no key
 * entered — no package manager, no download on first use, no account. So the
 * model is a build input, fetched here and packaged with the app, exactly like
 * an icon.
 *
 * That is also why transcription runs on-device rather than through a service.
 * Speech is the most sensitive thing a person can hand an agent: it captures
 * whoever else is in the room, and it captures them before anyone has decided
 * the recording is worth keeping. Sending that to a third party to be turned
 * into text is a promise nobody wants to have to make. Here the audio never
 * leaves the machine, which is a sentence you can say to a security review
 * without qualification.
 *
 * Run automatically before packaging; safe to run repeatedly, since it skips
 * files it already has.
 */
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/**
 * `base.en` rather than `tiny.en`.
 *
 * Tiny is half the size and noticeably worse on exactly the words dictation
 * exists for: names, product terms, anything unusual. A transcript that has to
 * be corrected by hand costs more time than it saved, and people stop using the
 * feature after two or three of those. Fifty megabytes is a cheaper price than
 * a feature nobody trusts.
 */
const MODEL = "Xenova/whisper-base.en";

/** Only what the pipeline actually loads: no PyTorch weights, no fp32 duplicates. */
const FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
];

const target = join(ROOT, "resources", "models", MODEL);

async function alreadyHave(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

let fetched = 0;
for (const file of FILES) {
  const destination = join(target, file);
  if (await alreadyHave(destination)) continue;
  await mkdir(dirname(destination), { recursive: true });
  const url = `https://huggingface.co/${MODEL}/resolve/main/${file}`;
  process.stdout.write(`  fetching ${file} … `);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`${url} → ${response.status}. The model must be present before packaging.`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
  const { size } = await stat(destination);
  console.log(`${(size / 1024 / 1024).toFixed(1)} MB`);
  fetched += 1;
}

console.log(fetched === 0 ? "speech model already present" : `speech model ready (${fetched} file(s))`);
