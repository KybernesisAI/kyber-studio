/**
 * Who a message in a room is for.
 *
 * A room needs one rule that a person can hold in their head, because every
 * message they type is a routing decision whether they think about it or not.
 * The rule is the one people already use in a group chat:
 *
 *   - name someone  → only they answer
 *   - @everyone     → all of them answer
 *   - name no one   → the room's default (see RoomPolicy at the call site)
 *
 * Deliberately literal string matching, not intent detection. A router that
 * guesses is a router that is sometimes wrong in a way the user cannot see or
 * correct, and the cost of being wrong is a turn billed to the wrong agent —
 * or worse, a private question answered in front of everyone.
 */

/** The name that means "all of you". Matched case-insensitively. */
export const EVERYONE = "everyone";
const EVERYONE_ALIASES = [EVERYONE, "all", "team", "both"];

export interface Addressed {
  /** Ids of the members named explicitly. Empty when none were. */
  ids: string[];
  /** True when the message addressed the whole room. */
  everyone: boolean;
  /** True when the message addressed ANYONE — the caller decides what to do when not. */
  explicit: boolean;
}

/** A name is user data and can contain characters a regex would read as syntax. */
function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Read a message for the members it names.
 *
 * Longest names first, so "@Chief of Staff" is never matched as "@Chief" when
 * both are in the room. The `@` is required: an agent called "Design" would
 * otherwise be summoned by the word "design" in an ordinary sentence, which is
 * the difference between a room you can talk in and one you must tiptoe around.
 */
export function addressedIn(
  text: string,
  members: { id: string; name: string }[],
): Addressed {
  const byLongestName = [...members].sort((a, b) => b.name.length - a.name.length);
  const ids: string[] = [];

  let rest = text;
  for (const member of byLongestName) {
    const pattern = new RegExp(`@${escapeForRegex(member.name)}\\b`, "i");
    if (pattern.test(rest)) {
      ids.push(member.id);
      // Remove it so a shorter name inside a longer one cannot match twice.
      rest = rest.replace(new RegExp(`@${escapeForRegex(member.name)}\\b`, "gi"), " ");
    }
  }

  const everyone = EVERYONE_ALIASES.some((alias) =>
    new RegExp(`@${alias}\\b`, "i").test(text),
  );

  return { ids, everyone, explicit: everyone || ids.length > 0 };
}

/**
 * What happens to a message that names nobody.
 *
 * - "all": every member answers. Natural in a two-agent room, and unbearable
 *   in a six-agent one — every stray "thanks" costs six turns.
 * - "lead": the first member answers and is expected to bring others in. This
 *   is how a real team works: you talk to the person running it.
 * - "silent": nobody answers unless named. Precise, and it makes the room feel
 *   broken to anyone who forgets the convention.
 */
export type RoomPolicy = "all" | "lead" | "silent";

/** The members that should answer a message, given the room's policy. */
export function recipientsFor(
  text: string,
  members: { id: string; name: string }[],
  policy: RoomPolicy,
): string[] {
  const addressed = addressedIn(text, members);
  if (addressed.everyone) return members.map((m) => m.id);
  if (addressed.ids.length > 0) return addressed.ids;

  switch (policy) {
    case "all":
      return members.map((m) => m.id);
    case "lead":
      return members[0] ? [members[0].id] : [];
    case "silent":
      return [];
  }
}
