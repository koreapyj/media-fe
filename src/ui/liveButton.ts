import shaka from 'shaka-player/dist/shaka-player.ui.js';

/** Within this many seconds of the live edge we consider playback "at live". */
const LIVE_EDGE_THRESHOLD_S = 5;

/**
 * Control-bar "LIVE" button: shown only for live streams. Click jumps to the live edge
 * (`player.goToLive()`). The dot turns red while at the edge and dims when scrubbed back.
 */
class LiveButton extends shaka.ui.Element {
  private readonly button: HTMLButtonElement;

  constructor(parent: HTMLElement, controls: shaka.ui.Controls) {
    super(parent, controls);

    const button = document.createElement('button');
    button.classList.add('shaka-live-button', 'shaka-tooltip');
    button.setAttribute('aria-label', 'Go to live');
    const dot = document.createElement('span');
    dot.className = 'shaka-live-dot';
    const label = document.createElement('span');
    label.className = 'shaka-live-label';
    label.textContent = 'LIVE';
    button.append(dot, label);
    this.button = button;
    this.parent!.appendChild(button);

    this.eventManager!.listen(button, 'click', () => {
      if (this.player?.isLive()) this.player.goToLive();
    });
    for (const evt of ['loaded', 'unloading', 'manifestupdated', 'trackschanged']) {
      this.eventManager!.listen(this.player!, evt, () => this.update());
    }
    for (const evt of ['timeupdate', 'seeking', 'seeked']) {
      this.eventManager!.listen(this.video!, evt, () => this.updateEdge());
    }
    this.update();
  }

  /** Show only for live content; refresh the edge state. */
  private update(): void {
    const live = !!this.player?.isLive();
    this.button.style.display = live ? '' : 'none';
    if (live) this.updateEdge();
  }

  /** Mark the button as "at the live edge" when currentTime is near seekRange().end. */
  private updateEdge(): void {
    if (!this.player?.isLive()) return;
    const end = this.player.seekRange().end;
    const atEdge =
      Number.isFinite(end) && end - (this.video?.currentTime ?? 0) <= LIVE_EDGE_THRESHOLD_S;
    this.button.classList.toggle('shaka-live-edge', atEdge);
  }
}

let registered = false;

/** Register the 'live' control-bar button (idempotent). Call before creating the Overlay. */
export function registerLiveButton(): void {
  if (registered) return;
  registered = true;
  const factory: shaka.extern.IUIElement.Factory = {
    create: (root, controls) => new LiveButton(root, controls),
  };
  shaka.ui.Controls.registerElement('live', factory);
}
