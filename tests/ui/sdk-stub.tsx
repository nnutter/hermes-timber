import { atom } from "nanostores";
import { vi } from "vitest";
import type { ComponentProps } from "react";
import { QueryClient } from "@tanstack/react-query";
export { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
export const queryClient = new QueryClient();

let epoch = 0;
const listeners = new Set<() => void>();
export const gatewayActivationEpoch = () => epoch;
export const host = {
  state: {
    connectionId: atom<string | null>("local"),
    profile: atom("default"),
    gateway: atom("open"),
    cwd: atom(""),
    focusedStoredSessionId: atom<string | null>(null),
    viewport: atom({ width: 1440, height: 900, narrow: false }),
  },
  onEvent: (_type: string, listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  request:
    vi.fn<
      (method: string, params?: Record<string, unknown>) => Promise<unknown>
    >(),
  openSession:
    vi.fn<
      (session: string, options?: Record<string, unknown>) => Promise<void>
    >(),
  revealPane: vi.fn<(id: string) => void>(),
  navigate: vi.fn<(path: string) => void>(),
  notify: vi.fn<(input: { kind: string; message: string }) => string>(
    () => "notice",
  ),
};
export const os = {
  openExternal: vi.fn<(url: string) => Promise<boolean>>(async () => true),
  revealPath: vi.fn<(path: string) => Promise<boolean>>(async () => true),
};
export function switchScope(connection: string, profile = "default") {
  epoch++;
  host.state.connectionId.set(connection);
  host.state.profile.set(profile);
  listeners.forEach((listener) => listener());
}
export function resetHost() {
  epoch++;
  host.state.connectionId.set("local");
  host.state.profile.set("default");
  host.state.gateway.set("open");
  host.state.cwd.set("");
  host.request.mockReset();
  host.openSession.mockReset();
  host.revealPane.mockReset();
  host.navigate.mockReset();
  host.notify.mockClear();
  os.openExternal.mockReset();
  os.openExternal.mockImplementation(async () => true);
  os.revealPath.mockReset();
  queryClient.clear();
}
export const PALETTE_AREA = "palette";
export const KEYBINDS_AREA = "keybinds";
export const ROUTES_AREA = "routes";
export const SIDEBAR_NAV_AREA = "sidebar.nav";
export function Button({
  variant: _variant,
  size: _size,
  loading,
  ...props
}: ComponentProps<"button"> & {
  variant?: string;
  size?: string;
  loading?: boolean;
}) {
  return <button {...props} disabled={props.disabled || loading} />;
}
export function Input(props: ComponentProps<"input">) {
  return <input {...props} />;
}
export function Badge({
  variant,
  size: _size,
  ...props
}: ComponentProps<"span"> & { variant?: string; size?: string }) {
  return <span data-variant={variant} {...props} />;
}

export function Codicon({
  name,
  spinning: _spinning,
  ...props
}: ComponentProps<"i"> & { name: string; spinning?: boolean }) {
  return <i aria-hidden="true" data-icon={name} {...props} />;
}
