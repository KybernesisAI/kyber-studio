/**
 * One retry, on a fresh policy bundle, when an agent says "not granted".
 *
 * An agent checks grants against `agentGrants` in the policy bundle, and that
 * list is baked in when the bundle is MINTED. Studio reuses the stored
 * token+bundle until they are within two minutes of expiry — across restarts
 * too, since the pair lives in session.bin — so an agent registered or granted
 * after the mint answered `403 agent_not_granted` to every request for up to a
 * whole bundle lifetime. That is what a freshly registered agent (Sally,
 * 2026-09-25) looked like: broken, with a correct grant in the control plane.
 *
 * The agent is the authority on what the bundle says, so its 403 is the signal
 * to get a new one: refresh once, and retry once. Exactly once — if a
 * genuinely fresh bundle is still refused, the grant really is missing, and the
 * person needs to see that error rather than a loop.
 *
 * No Electron and no network here, so the rule is tested directly
 * (test/grant-retry.test.mjs); controlPlane supplies the real refresh.
 */

/** The agent's refusal code for a principal its bundle does not grant. */
export const NOT_GRANTED = "agent_not_granted";

export function isNotGranted(status: number, body: string | undefined): boolean {
  return status === 403 && typeof body === "string" && body.includes(NOT_GRANTED);
}

/**
 * Re-mint the credential. Resolves true only when the result can change the
 * answer — a NEW bundle. A refresh that failed, or handed back the same
 * bundle, makes a retry pointless.
 */
export type Remint = () => Promise<boolean>;

/**
 * For calls that THROW on a non-2xx (the eve client's ClientError). `status`
 * and `body` read the error; anything else is rethrown untouched.
 */
export async function retryOnNotGranted<T>(
  attempt: () => Promise<T>,
  remint: Remint,
  read: (error: unknown) => { status: number; body?: string } | null,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    const seen = read(error);
    if (!seen || !isNotGranted(seen.status, seen.body)) throw error;
    console.log("[auth] agent_not_granted — re-minting the bundle and retrying once");
    if (!(await remint())) throw error;
    // The second attempt's outcome is final, success or failure.
    return await attempt();
  }
}

/**
 * For calls that RETURN a Response. `send` must build its request afresh each
 * time — headers included — so the retry carries the re-minted bundle.
 */
export async function fetchRetryOnNotGranted(send: () => Promise<Response>, remint: Remint): Promise<Response> {
  const first = await send();
  if (first.status !== 403) return first;
  // Read a clone: when this is not the refusal we handle, the caller still
  // gets an unread body to report from.
  const body = await first
    .clone()
    .text()
    .catch(() => "");
  if (!isNotGranted(first.status, body)) return first;
  console.log("[auth] agent_not_granted — re-minting the bundle and retrying once");
  if (!(await remint())) return first;
  return await send();
}
