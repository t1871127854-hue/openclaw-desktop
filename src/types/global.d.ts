import type { OpenClawApi } from './api';

declare global {
  interface Window {
    openclawApi?: OpenClawApi;
  }
}

export {};
