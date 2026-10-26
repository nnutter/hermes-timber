import { useSyncExternalStore } from "react";
import { gatewayActivationEpoch, host } from "@hermes/plugin-sdk";

// Include the epoch even if both connections expose the same profile name.
export function scopeKey(): string {
  return JSON.stringify([
    gatewayActivationEpoch(),
    host.state.connectionId.get(),
    host.state.profile.get(),
  ]);
}

function snapshot(): string {
  return JSON.stringify([scopeKey(), host.state.gateway.get()]);
}

function subscribe(changed: () => void): () => void {
  const disposers = [
    host.state.profile.listen(changed),
    host.state.connectionId.listen(changed),
    host.state.gateway.listen(changed),
    host.onEvent("*", changed),
  ];
  return () => disposers.forEach((dispose) => dispose());
}

export function useScope(): { key: string; online: boolean } {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return { key: scopeKey(), online: host.state.gateway.get() === "open" };
}

export function assertScope(key: string): void {
  if (scopeKey() !== key || host.state.gateway.get() !== "open") {
    throw new Error(
      "The gateway changed or is offline. Refresh Timber before continuing.",
    );
  }
}
