import { useSyncExternalStore } from "react";
import { navigate } from "wouter/use-hash-location";

// wouter's built-in useHashLocation returns the raw hash verbatim, including any
// "?query" portion. That breaks exact route matching for URLs like
// "#/office-setup/complete?session_id=cs_test_123": the query is left on the
// path, so the exact "/office-setup/complete" route no longer matches and the
// looser "/office-setup/:token" route swallows it instead (token becomes
// "complete?session_id=..."). This hook strips the query before matching so the
// intended route renders immediately. Components that need the query still read
// it directly from window.location.hash.

// Splits a raw location.hash value into its path (leading "/") and search
// (leading "?") halves. Kept dependency-free so it can be unit tested directly.
export function splitHash(hash: string): { path: string; search: string } {
  const withoutHash = hash.replace(/^#/, "");
  const q = withoutHash.indexOf("?");
  const rawPath = q === -1 ? withoutHash : withoutHash.slice(0, q);
  const search = q === -1 ? "" : withoutHash.slice(q);
  const path = "/" + rawPath.replace(/^\/+/, "");
  return { path, search };
}

export function hashToPath(hash: string): string {
  return splitHash(hash).path;
}

export function hashToSearch(hash: string): string {
  return splitHash(hash).search;
}

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

const getPathSnapshot = () => hashToPath(window.location.hash);

export const useHashLocation = ({ ssrPath = "/" }: { ssrPath?: string } = {}): [
  string,
  typeof navigate,
] => [
  useSyncExternalStore(subscribe, getPathSnapshot, () => ssrPath),
  navigate,
];

useHashLocation.hrefs = (href: string) => "#" + href;
useHashLocation.searchHook = () => hashToSearch(window.location.hash);
