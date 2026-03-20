import type {OpenClawApi} from './api';

declare global {
  interface Window {
    openClaw?: OpenClawApi;
  }
}

export {};
