/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional override for the JSON manifest URL (defaults to `config.json` under the app base). */
  readonly VITE_CONFIG_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Detected application base path, set by the inline bootstrap in index.html. */
interface Window {
  __APP_BASE__?: string;
}

// libass-wasm (SubtitlesOctopus) ships no type declarations.
declare module 'libass-wasm' {
  export interface SubtitlesOctopusOptions {
    video?: HTMLVideoElement;
    canvas?: HTMLCanvasElement;
    subUrl?: string;
    subContent?: string;
    workerUrl?: string;
    legacyWorkerUrl?: string;
    fonts?: string[];
    availableFonts?: Record<string, string>;
    fallbackFont?: string;
    lazyFileLoading?: boolean;
    renderMode?: 'wasm-blend' | 'js-blend' | 'lossy';
    targetFps?: number;
    timeOffset?: number;
    debug?: boolean;
    onReady?: () => void;
    onError?: (error: unknown) => void;
  }

  export default class SubtitlesOctopus {
    constructor(options: SubtitlesOctopusOptions);
    setTrack(content: string): void;
    setTrackByUrl(url: string): void;
    freeTrack(): void;
    createEvent(event: Record<string, unknown>): void;
    setEvent(event: Record<string, unknown>, index: number): void;
    removeEvent(index: number): void;
    getEvents(
      onSuccess: (events: Array<Record<string, unknown> & { _index: number }>) => void,
      onError: (error: unknown) => void,
    ): void;
    getStyles(
      onSuccess: (styles: Array<{ Name: string; _index: number } & Record<string, unknown>>) => void,
      onError: (error: unknown) => void,
    ): void;
    createStyle(style: Record<string, unknown>): void;
    setStyle(style: Record<string, unknown>, index: number): void;
    setCurrentTime(currentTime: number): void;
    setIsPaused(isPaused: boolean, currentTime?: number): void;
    resize(width?: number, height?: number, top?: number, left?: number): void;
    dispose(): void;
    timeOffset: number;
  }
}
