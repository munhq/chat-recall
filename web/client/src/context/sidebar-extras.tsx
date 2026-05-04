import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { SidebarSection } from '../components/Sidebar';

/**
 * Per-view filter sections rendered in the global Sidebar.
 *
 * Top-level views (Memory/Toolkit/Activity/Insights) call
 * `useSidebarExtras(sections)` from their render and the sidebar picks
 * the value up. We keep the cleared state when the view unmounts so the
 * sidebar collapses back to just Source + Projects on the next view.
 */
const Ctx = createContext<{
  sections: SidebarSection[];
  setSections: (s: SidebarSection[]) => void;
}>({
  sections: [],
  setSections: () => {},
});

export function SidebarExtrasProvider({ children }: { children: React.ReactNode }) {
  const [sections, setSections] = useState<SidebarSection[]>([]);
  const stableSet = useCallback((s: SidebarSection[]) => setSections(s), []);
  return (
    <Ctx.Provider value={{ sections, setSections: stableSet }}>
      {children}
    </Ctx.Provider>
  );
}

/** Read the current sections — used by the Sidebar component. */
export function useSidebarExtras(): SidebarSection[] {
  return useContext(Ctx).sections;
}

/**
 * Register sections from a view. Sections are recomputed any time the
 * `deps` array changes, so callers should pass their state as deps.
 */
export function useSidebarExtrasRegister(
  build: () => SidebarSection[],
  deps: React.DependencyList,
): void {
  const { setSections } = useContext(Ctx);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setSections(build());
    return () => setSections([]);
    // We deliberately depend only on the caller-supplied deps, not on
    // `build` itself — callers pass an inline arrow each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
