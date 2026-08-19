import { type ReactNode, useEffect, useState } from "react";
import { UpdateRow } from "./UpdateRow";
import type { Agent, Block, Room } from "@shared/types";
import { useStore } from "@/lib/store";
import { Avatar, Icon, timeLabel } from "./primitives";

/** The right-click menu is about one row, and a row is an agent or a group. */
type MenuState =
  | { x: number; y: number; agent: Agent; room?: never }
  | { x: number; y: number; room: Room; agent?: never };

function ContextMenu({
  state,
  onClose,
}: {
  state: MenuState;
  onClose(): void;
}): ReactNode {
  const { patchAgent, setPanel, select, patchRoom, deleteRoom } = useStore();
  const { agent, room } = state;
  // Deleting a group throws away its transcript, and a context menu is one
  // slip of the wrist away from any item on it. Ask once.
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const dismiss = (): void => onClose();
    window.addEventListener("click", dismiss);
    window.addEventListener("contextmenu", dismiss);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("contextmenu", dismiss);
    };
  }, [onClose]);

  const item = (icon: string, label: string, action: () => void, danger = false): ReactNode => (
    <button
      className={`menu__item${danger ? " menu__item--danger" : ""}`}
      onClick={() => {
        action();
        onClose();
      }}
    >
      <Icon name={icon} />
      {label}
    </button>
  );

  // Keep the menu on screen when the click lands near the bottom edge.
  const top = Math.min(state.y, window.innerHeight - (room ? 150 : 330));

  if (room) {
    const members = room.memberIds.length;
    return (
      <div className="menu" style={{ left: state.x, top }} onClick={(e) => e.stopPropagation()}>
        {item("pin", room.pinned ? "Unpin" : "Pin", () =>
          patchRoom(room.id, { pinned: !room.pinned }),
        )}
        <div className="menu__sep" />
        {item("copy", "Copy conversation ID", () => {
          void navigator.clipboard.writeText(room.id);
        })}
        <div className="menu__sep" />
        {/* Not routed through item(): the first click must NOT close the menu,
            because the whole point is that the second click is deliberate. */}
        <button
          className="menu__item menu__item--danger"
          onClick={(e) => {
            e.stopPropagation();
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            deleteRoom(room.id);
            onClose();
          }}
        >
          <Icon name="trash" />
          {confirmDelete
            ? `Delete this group and its messages?`
            : `Delete group${members ? ` of ${members}` : ""}`}
        </button>
      </div>
    );
  }

  return (
    <div className="menu" style={{ left: state.x, top }} onClick={(e) => e.stopPropagation()}>
      {item("pin", agent.pinned ? "Unpin" : "Pin", () => patchAgent(agent.id, { pinned: !agent.pinned }))}
      {item("bell", agent.unread ? "Mark as Read" : "Mark as Unread", () =>
        patchAgent(agent.id, { unread: !agent.unread }),
      )}
      <div className="menu__sep" />
      {item("pencil", "Edit Profile", () => {
        select(agent.id);
        setPanel("settings");
      })}
      <div className="menu__sep" />
      {item("copy", "Copy conversation ID", () => {
        void navigator.clipboard.writeText(agent.id);
      })}
      <div className="menu__sep" />
      {item("eyeOff", "Hide from sidebar", () => patchAgent(agent.id, { hidden: true }))}
      {item("trash", "Delete", () => patchAgent(agent.id, { hidden: true }), true)}
    </div>
  );
}

/**
 * The preview is DERIVED from the transcript, not stored on the agent.
 *
 * The agent list is rebuilt from the control plane on every launch, so anything
 * kept on those objects is lost while the conversation that persisted sits
 * right there — every row read "No messages yet" above a chat full of messages.
 * One source of truth: the messages.
 */
function lastOf(blocks: Block[] | undefined): { text: string; at: number } | null {
  if (!blocks?.length) return null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b?.kind === "text" && b.text.trim()) {
      return { text: b.text.replace(/\s+/g, " ").trim(), at: b.at };
    }
  }
  return null;
}

function Row({
  agent,
  onMenu,
}: {
  agent: Agent;
  onMenu(state: MenuState): void;
}): ReactNode {
  const { activeAgentId, select, conversations } = useStore();
  const active = agent.id === activeAgentId;
  const last = lastOf(conversations[agent.id]);

  return (
    <div
      className={`row${active ? " row--active" : ""}`}
      onClick={() => select(agent.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        select(agent.id);
        onMenu({ x: e.clientX, y: e.clientY, agent });
      }}
    >
      <Avatar name={agent.name} accent={agent.accent} src={agent.avatar} />
      <div className="row__body">
        <div className="row__line">
          <span className="row__name">{agent.name}</span>
          {agent.pinned ? <span className="row__pin"><Icon name="pin" size={12} /></span> : null}
          <span className="row__time">{last ? timeLabel(last.at) : ""}</span>
        </div>
        <div className="row__line">
          <div className="row__preview">{last?.text ?? "No messages yet"}</div>
          {agent.unread ? <span className="row__unread" /> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * A room in the list: every member's avatar, and their names as the title.
 *
 * Rooms are not given names by default and should not be — a customer who has
 * put three agents in a room knows it by who is in it, and asking them to name
 * it first is a form to fill in before the useful thing.
 */
function RoomRow({ room, onMenu }: { room: Room; onMenu(state: MenuState): void }): ReactNode {
  const { agents, activeAgentId, select, conversations } = useStore();
  const members = room.memberIds
    .map((id: string) => agents.find((a) => a.id === id))
    .filter((a): a is Agent => Boolean(a));
  const last = lastOf(conversations[room.id]);
  const title = room.name ?? members.map((m: Agent) => m.name).join(", ");

  return (
    <div
      className={`row${activeAgentId === room.id ? " row--active" : ""}`}
      onClick={() => select(room.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu({ x: e.clientX, y: e.clientY, room });
      }}
    >
      <span className="stack">
        {members.slice(0, 3).map((m: Agent) => (
          <Avatar key={m.id} name={m.name} accent={m.accent} src={m.avatar} size={34} />
        ))}
      </span>
      <div className="row__body">
        <div className="row__line">
          <span className="row__name">{title}</span>
          {room.pinned ? <Icon name="pin" size={12} /> : null}
          {last ? <span className="row__time">{timeLabel(last.at)}</span> : null}
        </div>
        <div className="row__preview">{last?.text ?? "No messages yet"}</div>
      </div>
    </div>
  );
}

/**
 * Choosing who is in a new room.
 *
 * Opens with nobody selected and creates nothing until at least two agents are
 * chosen: a "room" with one member is just a conversation, and making one by
 * accident leaves a duplicate of a chat the user already has.
 */
function NewRoom({ onClose }: { onClose: () => void }): ReactNode {
  const { agents, createRoom } = useStore();
  const [picked, setPicked] = useState<string[]>([]);
  const available = agents.filter((a) => !a.hidden);

  const toggle = (id: string): void =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <div className="newroom">
      <div className="newroom__head">
        <span className="newroom__label">To:</span>
        <div className="newroom__picked">
          {picked.length === 0 ? (
            <span className="muted">Choose two or more agents</span>
          ) : (
            picked.map((id) => {
              const a = agents.find((x) => x.id === id);
              if (!a) return null;
              return (
                <button key={id} className="agent-chip" onClick={() => toggle(id)} title="Remove">
                  <span className="mention__icon" style={{ background: a.accent }}>
                    {a.name.trim().charAt(0).toUpperCase()}
                  </span>
                  {a.name}
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="newroom__list">
        {available.map((a) => (
          <button
            key={a.id}
            className={`newroom__opt${picked.includes(a.id) ? " newroom__opt--on" : ""}`}
            onClick={() => toggle(a.id)}
          >
            <Avatar name={a.name} accent={a.accent} src={a.avatar} size={20} />
            <span>{a.name}</span>
            {picked.includes(a.id) ? <Icon name="check" size={14} /> : null}
          </button>
        ))}
      </div>

      <div className="newroom__foot">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn--primary"
          disabled={picked.length < 2}
          onClick={() => {
            createRoom(picked);
            onClose();
          }}
        >
          Start
        </button>
      </div>
    </div>
  );
}

export function Sidebar(): ReactNode {
  const { agents, query, setPluginsOpen, setPaletteOpen, account, signOut, refreshAgents, issuer } =
    useStore();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [accountMenu, setAccountMenu] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const rooms = useStore((s) => s.rooms);

  const q = query.trim().toLowerCase();
  const visible = agents
    .filter((a) => !a.hidden)
    .filter((a) => !q || a.name.toLowerCase().includes(q) || (a.lastMessagePreview ?? "").toLowerCase().includes(q));

  // Most recently active first, from the transcripts themselves.
  const recency = (a: Agent): number => lastOf(useStore.getState().conversations[a.id])?.at ?? 0;
  const byRecent = [...visible].sort((x, y) => recency(y) - recency(x));
  const pinned = byRecent.filter((a) => a.pinned);
  const rest = byRecent.filter((a) => !a.pinned);

  return (
    <aside className="sidebar">
      <div className="sidebar__top">
        <button
          className="topbar__btn"
          title="New group conversation"
          style={{ WebkitAppRegion: "no-drag" } as never}
          onClick={() => setNewRoom((v) => !v)}
        >
          <Icon name="plus" />
        </button>
      </div>

      <div className="sidebar__search">
        <button className="search search--button" onClick={() => setPaletteOpen(true)}>
          <Icon name="search" size={14} />
          <span className="search__placeholder">Search</span>
          <span className="kbd">⌘K</span>
        </button>
      </div>

      {newRoom ? <NewRoom onClose={() => setNewRoom(false)} /> : null}

      <div className="sidebar__list">
        {rooms.length > 0 ? (
          <>
            <div className="section-head">Groups</div>
            {[...rooms]
              .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
              .map((r) => (
                <RoomRow key={r.id} room={r} onMenu={setMenu} />
              ))}
            <div className="section-head">Agents</div>
          </>
        ) : null}
        {pinned.length > 0 ? (
          <>
            <div className="section-head">Pinned</div>
            {pinned.map((a) => (
              <Row key={a.id} agent={a} onMenu={setMenu} />
            ))}
            {rest.length > 0 ? <div className="section-head">Agents</div> : null}
          </>
        ) : null}
        {rest.map((a) => (
          <Row key={a.id} agent={a} onMenu={setMenu} />
        ))}
        {visible.length === 0 ? <div className="empty">No agents match “{query}”.</div> : null}
      </div>

      <div className="sidebar__foot">
        {/* Above Plugins, and only when there is something to do. */}
        <UpdateRow />
        <button className="foot-row" onClick={() => setPluginsOpen(true)}>
          <Icon name="plug" />
          <span className="foot-row__label">Plugins</span>
        </button>
        <button className="foot-row" onClick={() => setAccountMenu((v) => !v)}>
          <Avatar name={account?.email ?? "?"} accent="#1b3a34" size={26} />
          <span className="foot-row__label">
            <span style={{ display: "block" }}>{account?.email ?? "Not signed in"}</span>
            {account?.orgName ? (
              <span style={{ display: "block", fontSize: 11.5, color: "var(--ink-tertiary)" }}>
                {account.orgName}
              </span>
            ) : null}
          </span>
          <Icon name="chevronRight" size={13} />
        </button>

        {accountMenu ? (
          <div className="account-menu">
            <button
              className="menu__item"
              onClick={() => {
                setAccountMenu(false);
                void refreshAgents();
              }}
            >
              <Icon name="download" /> Refresh agents
            </button>
            <div className="menu__sep" />
            <button
              className="menu__item menu__item--danger"
              onClick={() => {
                setAccountMenu(false);
                void signOut();
              }}
            >
              <Icon name="close" /> Sign out
            </button>
            <div className="account-menu__issuer">{issuer}</div>
          </div>
        ) : null}
      </div>

      {menu ? <ContextMenu state={menu} onClose={() => setMenu(null)} /> : null}
    </aside>
  );
}
