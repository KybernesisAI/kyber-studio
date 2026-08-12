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
