/**
 * What the chat SHOWS: the blocks after the latest "New conversation" divider.
 *
 * New conversation clears the view — that is what the person asked for — but
 * nothing is deleted. The earlier conversation and its divider stay in the
 * stored transcript (conversations.json), where a future "past conversations"
 * list can read them. The view and the sidebar preview both derive from this,
 * so neither can show the archive by accident.
 */
export function currentConversation<B extends { kind: string }>(blocks: readonly B[]): B[] {
  let start = 0;
  blocks.forEach((b, i) => {
    if (b.kind === "divider") start = i + 1;
  });
  return blocks.slice(start);
}

/** A fresh start nobody has spoken into yet: there is a divider, and nothing after it. */
export function isFreshStart(blocks: readonly { kind: string }[]): boolean {
  return blocks.length > 0 && blocks[blocks.length - 1].kind === "divider";
}
