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
  return JSON.stringify([
    scopeKey(),
    host.state.gateway.get(),
    host.state.cwd.get(),
  ]);
}

function subscribe(changed: () => void): () => void {
  const disposers = [
    host.state.profile.listen(changed),
    host.state.connectionId.listen(changed),
    host.state.gateway.listen(changed),
    host.state.cwd.listen(changed),
    host.onEvent("*", changed),
  ];
  return () => disposers.forEach((dispose) => dispose());
}

export function useScope(): { key: string; online: boolean; cwd: string } {
  const value = JSON.parse(
    useSyncExternalStore(subscribe, snapshot, snapshot),
  ) as [string, string, string];
  return { key: value[0], online: value[1] === "open", cwd: value[2] };
}

export function assertScope(key: string): void {
  if (scopeKey() !== key || host.state.gateway.get() !== "open") {
    throw new Error(
      "The gateway changed or is offline. Refresh Timber before continuing.",
    );
  }
}
