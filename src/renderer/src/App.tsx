import { type ReactNode, useEffect } from "react";
import { Conversation } from "./components/Conversation";
import { Palette } from "./components/Palette";
import { Panel } from "./components/Panel";
import { Plugins } from "./components/Plugins";
import { Sidebar } from "./components/Sidebar";
import { SignIn } from "./components/SignIn";
import { useStore } from "./lib/store";

export function App(): ReactNode {
  const { setPaletteOpen, paletteOpen, bootstrap, authState } = useStore();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Follow the open thread live while nothing of ours is in flight in it.
  const activeAgentId = useStore((s) => s.activeAgentId);
  const activeSession = useStore((s) => (s.activeAgentId ? s.sessions[s.activeAgentId] : undefined));
  const activeInflight = useStore((s) => (s.activeAgentId ? Boolean(s.inflight[s.activeAgentId]) : false));
  const watchActive = useStore((s) => s.watchActive);
  const stopWatching = useStore((s) => s.stopWatching);
  useEffect(() => {
    if (authState !== "signed-in") return;
    watchActive();
  }, [authState, activeAgentId, activeSession, activeInflight, watchActive]);
  useEffect(() => () => stopWatching(), [stopWatching]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(!paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, setPaletteOpen]);

  if (authState === "signed-out") return <SignIn />;

  return (
    <div className="app">
      <Sidebar />
      <Conversation />
      <Panel />
      <Plugins />
      <Palette />
    </div>
  );
}
