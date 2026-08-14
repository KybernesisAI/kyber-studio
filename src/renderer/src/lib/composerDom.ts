/**
 * The composer is a contenteditable, and these are the only places that touch
 * its DOM.
 *
 * A textarea cannot hold a chip — it holds a string — so addressing an agent
 * could only ever look like the literal text "@sid". Going contenteditable buys
 * the chip and costs caret management, which is why every operation lives here
 * as a plain function over an element: they are the parts that break, and they
 * break silently in ways typechecking never catches.
 *
 * The rule the rest of the app relies on: what the user SEES is chips, and what
 * `serialize` returns is what gets sent. A chip serializes back to `@Name`, so
 * the agent receives exactly the text it would have received from a textarea.
 */

export interface MentionRef {
  name: string;
  accent?: string;
}

/** Turn the editor's contents into the message text. */
export function serialize(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent ?? "";
        continue;
      }
      if (!(child instanceof HTMLElement)) continue;
      if (child.dataset.mention) {
        out += `@${child.dataset.mention}`;
        continue;
      }
      if (child.tagName === "BR") {
        out += "\n";
        continue;
      }
      // A pasted paragraph or div is a line of its own.
      if (child.tagName === "DIV" || child.tagName === "P") {
        if (out && !out.endsWith("\n")) out += "\n";
        walk(child);
        continue;
      }
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** Build a chip. `contenteditable=false` makes it delete as one unit. */
export function chipElement(mention: MentionRef): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "mention";
  chip.contentEditable = "false";
  chip.dataset.mention = mention.name;

  // Built by hand rather than rendered, but identical to <Avatar size={14} />:
  // same class, same shape, same initial, so a chip in the composer and a chip
  // in the sent message are the same object to the eye.
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.style.width = "14px";
  avatar.style.height = "14px";
  avatar.style.background = mention.accent ?? "#7c6cf0";
  avatar.style.fontSize = `${14 * 0.42}px`;
  avatar.textContent = mention.name.trim().charAt(0).toUpperCase() || "?";

  chip.append(avatar, document.createTextNode(mention.name));
  return chip;
}

/**
 * Replace the `@term` the caret sits in with a chip.
 *
 * Returns false when there is nothing to replace — a pick from a menu that was
 * opened and then abandoned, for instance — so the caller can leave the editor
 * alone rather than inserting a chip somewhere arbitrary.
 */
export function replaceTriggerWithChip(root: HTMLElement, mention: MentionRef): boolean {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const node = range?.startContainer;
  if (!range || !node || node.nodeType !== Node.TEXT_NODE) return false;
  if (!root.contains(node)) return false;

  const text = node.textContent ?? "";
  const before = text.slice(0, range.startOffset);
  // The trigger, at a word boundary: an email address mid-typing is not one.
  const match = /(?:^|\s)@([\w-]*)$/.exec(before);
  if (!match) return false;

  const start = before.length - match[1].length - 1;
  const cut = document.createRange();
  cut.setStart(node, start);
  cut.setEnd(node, range.startOffset);
  cut.deleteContents();

  const chip = chipElement(mention);
  const space = document.createTextNode(" ");
  cut.insertNode(space);
  cut.insertNode(chip);

  // Caret after the trailing space, so typing continues normally.
  const after = document.createRange();
  after.setStart(space, space.length);
  after.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(after);
  return true;
}

/** The text between the start of the current word and the caret. */
export function triggerBeforeCaret(root: HTMLElement): { char: string; term: string } | null {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const node = range?.startContainer;
  if (!range || !node || !root.contains(node)) return null;
  const text = node.textContent ?? "";
  const before = text.slice(0, range.startOffset);
  const match = /(?:^|\s)([/@])([\w-]*)$/.exec(before);
  if (!match?.[1]) return null;
  return { char: match[1], term: (match[2] ?? "").toLowerCase() };
}

/** Drop the trigger text the user abandoned (Escape). */
export function removeTrigger(root: HTMLElement): void {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const node = range?.startContainer;
  if (!range || !node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return;
  const text = node.textContent ?? "";
  const before = text.slice(0, range.startOffset);
  const match = /([/@])[\w-]*$/.exec(before);
  if (!match) return;
  const cut = document.createRange();
  cut.setStart(node, before.length - match[0].length);
  cut.setEnd(node, range.startOffset);
  cut.deleteContents();
}

/** Insert plain text at the caret (skills, tools — everything that is not an agent). */
export function replaceTriggerWithText(root: HTMLElement, token: string): boolean {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const node = range?.startContainer;
  if (!range || !node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return false;
  const text = node.textContent ?? "";
  const before = text.slice(0, range.startOffset);
  const match = /([/@])[\w-]*$/.exec(before);
  if (!match) return false;

  const cut = document.createRange();
  cut.setStart(node, before.length - match[0].length);
  cut.setEnd(node, range.startOffset);
  cut.deleteContents();
  const inserted = document.createTextNode(token);
  cut.insertNode(inserted);

  const after = document.createRange();
  after.setStart(inserted, inserted.length);
  after.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(after);
  return true;
}

export function clear(root: HTMLElement): void {
  root.innerHTML = "";
}
