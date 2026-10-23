import { cardsOf, type Card } from "@kybernesis/cards";
import type { Block } from "@shared/types";

/**
 * Where each turn's cards are drawn: under the reply they belong to.
 *
 * A turn's work block comes before its reply (the agent acts, then answers), so
 * its cards move down to the next agent reply from the same speaker. Until that
 * reply exists, or when the turn ends without one, they stay with the steps.
 * Keyed by block id.
 */
export function placeCards(blocks: Block[]): { under: Map<string, Card[]>; atWork: Map<string, Card[]> } {
  const under = new Map<string, Card[]>();
  const atWork = new Map<string, Card[]>();
  let pending: Extract<Block, { kind: "work" }>[] = [];
  const settle = (): void => {
    for (const w of pending) {
      const cards = cardsOf(w.steps);
      if (cards.length) atWork.set(w.id, cards);
    }
    pending = [];
  };
  for (const b of blocks) {
    if (b.kind === "work") {
      pending.push(b);
    } else if (b.kind === "text" && b.role === "user") {
      settle();
    } else if (b.kind === "text" && b.role === "agent") {
      const mine = pending.filter((w) => !w.speakerId || !b.speaker || w.speakerId === b.speaker.id);
      if (mine.length) {
        const cards = cardsOf(mine.flatMap((w) => w.steps));
        if (cards.length) under.set(b.id, cards);
        pending = pending.filter((w) => !mine.includes(w));
      }
    }
  }
  settle();
  return { under, atWork };
}
