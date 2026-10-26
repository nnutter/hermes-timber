// Narrow declarations for the supported Hermes Desktop SDK surface used here.
// Source: apps/desktop/src/sdk/index.ts and its exported contracts.
declare module "@hermes/plugin-sdk" {
  import type { ReadableAtom } from "nanostores";
  import type { ComponentType, ComponentProps, ReactNode } from "react";
  export { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
  export interface PluginRestOptions {
    method?: string;
    body?: unknown;
    timeoutMs?: number;
  }
  export interface PluginContribution {
    id: string;
    area: string;
    title?: string;
    order?: number;
    render?: () => ReactNode;
    data?: unknown;
  }
  export interface PluginContext {
    register: (contribution: PluginContribution) => () => void;
    rest: <T>(path: string, options?: PluginRestOptions) => Promise<T>;
  }
  export interface HermesPlugin {
    id: string;
    name?: string;
    description?: string;
    register: (context: PluginContext) => void;
  }
  export interface PaletteContribution {
    id: string;
    label: string;
    keywords?: string[];
    run: () => void;
  }
  export const PALETTE_AREA: "palette";
  export const KEYBINDS_AREA: "keybinds";
  export interface KeybindContribution {
    id: string;
    label: string;
    category?: "view";
    defaults?: readonly string[];
    run: () => void;
  }
  export function gatewayActivationEpoch(): number;
  export const host: {
    state: {
      connectionId: ReadableAtom<string | null>;
      profile: ReadableAtom<string>;
      gateway: ReadableAtom<string>;
    };
    onEvent: (type: string, listener: () => void) => () => void;
    revealPane: (paneId: string) => void;
    request: <T>(
      method: string,
      params?: Record<string, unknown>,
      timeoutMs?: number,
    ) => Promise<T>;
    openSession: (
      storedSessionId: string,
      options?: {
        profile?: string | null;
        awaitHydration?: boolean;
        expectHistory?: boolean;
        keepAllProfilesScope?: boolean;
      },
    ) => Promise<void>;
  };
  export const Button: ComponentType<
    ComponentProps<"button"> & {
      variant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
      size?: "default" | "sm" | "xs";
      loading?: boolean;
    }
  >;
  export const Codicon: ComponentType<
    ComponentProps<"i"> & {
      name: string;
      size?: number | string;
      spinning?: boolean;
    }
  >;
  export const Input: ComponentType<ComponentProps<"input">>;
  export const Badge: ComponentType<
    ComponentProps<"span"> & {
      variant?:
        "default" | "muted" | "success" | "warn" | "destructive" | "outline";
      size?: "default" | "xs";
    }
  >;
}
