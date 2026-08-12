import type { ElectronAPI } from "@electron-toolkit/preload";
import type { StudioApi } from "../shared/ipc";

declare global {
  interface Window {
    electron: ElectronAPI;
    studio: StudioApi;
  }
}
