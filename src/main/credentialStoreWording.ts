/**
 * What Studio says when the OS credential store is unavailable: one
 * description of the state and one remedy, for every message that mentions it
 * (KYB-696).
 *
 * @remarks
 * This is the only place either is written. Until KYB-696 there were two
 * wording functions, one here in the main process and one in the renderer,
 * and every message composed its own sentence around the noun it got back.
 * Nothing tied those sentences together, so six messages described one
 * condition in three ways and some gave a remedy that does not work. The
 * Connect error, the two `[mcp]` log lines, and through the availability
 * answer the form warning, the form note and the eye message, all take their
 * description and remedy from here and write none of their own.
 *
 * The case comes from the platform AND the Linux backend, because the platform
 * alone cannot tell the two Linux cases apart (measured on Linux Mint 22.3,
 * 19 November 2026):
 *
 *  - A keyring backend whose unlock prompt was dismissed. Unlocking it and
 *    restarting Studio is the remedy: availability is latched for the process.
 *  - `basic_text`, where there is no keyring at all. "Unlock" names something
 *    that does not exist, and restarting alone gives the same answer.
 *
 * A backend name that could not be read (`null`) is treated as a keyring,
 * which is the same direction `credentialStoreCanProtect` takes with it.
 *
 * macOS and Windows keep the remedy they had, made consistent. Neither has
 * been measured, so nothing new is claimed for them.
 *
 * Pure, and both inputs are arguments, so a test can pin the platform rather
 * than inherit the host's. No Electron import: the caller reads the backend.
 */

/** One description of the state and one remedy, each a full sentence. */
export interface CredentialStoreWording {
  description: string;
  remedy: string;
}

export function credentialStoreWording(
  platform: string,
  backend: string | null,
): CredentialStoreWording {
  if (platform === "linux") {
    if (backend === "basic_text") {
      return {
        description: "No keyring was found on this computer.",
        remedy: "Set up a keyring, then restart Studio.",
      };
    }
    return {
      description: "Your keyring is locked.",
      remedy: "Unlock your keyring and restart Studio.",
    };
  }
  if (platform === "darwin") {
    return {
      description: "Your Keychain isn’t available.",
      remedy: "Unlock your Keychain and restart Studio.",
    };
  }
  // Windows calls its store the Credential Manager, and that name is
  // deliberately not used: nobody has reached this state on Windows, and an
  // instruction invented for an unmeasured platform is wrong advice in waiting.
  return {
    description: "Your credential store isn’t available.",
    remedy: "Unlock your credential store and restart Studio.",
  };
}
