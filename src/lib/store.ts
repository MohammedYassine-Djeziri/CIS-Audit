"use client";

import { create } from "zustand";
import type { AssetSummary } from "@/lib/types";

/**
 * Client state for the asset currently being worked with (plan §6).
 *
 * Key behavior: `setAsset` always clears `password` as part of the same
 * update, so navigating from one asset to another can never carry a stale
 * password along by accident. The password never touches
 * localStorage/sessionStorage or any persistence layer — it exists only in
 * memory for as long as it takes to complete one scan request, then is
 * cleared.
 */
interface CurrentAssetState {
  asset: AssetSummary | null;
  password: string;
  setAsset: (asset: AssetSummary) => void; // also resets password to ""
  setPassword: (password: string) => void;
  clearPassword: () => void;
}

export const useCurrentAsset = create<CurrentAssetState>((set) => ({
  asset: null,
  password: "",
  setAsset: (asset) => set({ asset, password: "" }),
  setPassword: (password) => set({ password }),
  clearPassword: () => set({ password: "" }),
}));
