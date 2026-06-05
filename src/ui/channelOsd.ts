import type { Channel } from '../playlist/types';
import { compareChno } from '../playlist/m3u';

/** Hide the OSD after this much idle time with no further input. */
const IDLE_HIDE_MS = 3_000;

export interface ChannelOsd {
  /** Handle a digit ('0'–'9') or '.' keypress for channel-number entry. */
  pressKey(key: string): void;
  /** Hide and reset the buffer. */
  hide(): void;
}

/**
 * On-screen channel-number entry (top-right). Digits/'.' build a buffer that prefix-matches channel
 * numbers: one candidate → tune immediately and hide; none → hide; many → keep the OSD showing the
 * buffer and the candidate list. Hides after 3 s idle; hiding clears the buffer.
 */
export function createChannelOsd(
  host: HTMLElement,
  channels: Channel[],
  onTune: (channel: Channel) => void,
): ChannelOsd {
  let buffer = '';
  let timer: number | undefined;
  let box: HTMLElement | null = null;

  const hide = (): void => {
    clearTimeout(timer);
    buffer = '';
    box?.remove();
    box = null;
  };

  const render = (candidates: Channel[]): void => {
    if (!box) {
      box = document.createElement('div');
      box.className = 'ch-osd';
      box.innerHTML = '<div class="ch-osd-input"></div><div class="ch-osd-list"></div>';
      host.appendChild(box);
    }
    (box.querySelector('.ch-osd-input') as HTMLElement).textContent = buffer;
    const list = box.querySelector('.ch-osd-list') as HTMLElement;
    list.replaceChildren();
    for (const c of candidates) {
      const row = document.createElement('div');
      row.className = 'ch-osd-cand';
      row.innerHTML = '<span class="ch-osd-cno"></span><span class="ch-osd-cname"></span>';
      (row.querySelector('.ch-osd-cno') as HTMLElement).textContent = c.chno ?? '';
      (row.querySelector('.ch-osd-cname') as HTMLElement).textContent = c.name;
      list.appendChild(row);
    }
  };

  const pressKey = (key: string): void => {
    buffer += key;
    const candidates = channels
      .filter((c) => c.chno != null && c.chno.startsWith(buffer))
      .sort((a, b) => compareChno(a.chno, b.chno));
    if (candidates.length === 0) {
      hide();
      return;
    }
    if (candidates.length === 1) {
      const only = candidates[0];
      hide();
      onTune(only);
      return;
    }
    render(candidates);
    clearTimeout(timer);
    timer = window.setTimeout(hide, IDLE_HIDE_MS);
  };

  return { pressKey, hide };
}
