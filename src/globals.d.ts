export {};

declare global {
  interface HTMLMediaElement {
    mozPreservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  }

  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
