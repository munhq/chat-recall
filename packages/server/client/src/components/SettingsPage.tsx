/**
 * SettingsPage — full-page rendering of the settings UI.
 *
 * Same content as SettingsDialog (which still exists for any callers that
 * want a modal), just rendered inline as a page. The shared component knows
 * which mode it's in via the `variant` prop.
 */
import React from 'react';
import SettingsDialog from './SettingsDialog';
import { ProjectSharing } from './TeamView';

export default function SettingsPage({ onClose }: { onClose: () => void }) {
  // open=true is a no-op in 'page' mode but kept for the shared signature;
  // the page version uses route mounting (App.tsx renders us only when
  // view === 'settings'), so we never need to gate on `open`.
  // Project sharing is a setting: a durable preference about who may see my
  // work, not a view of what the team did this week. It lived on the Team page
  // because that is where teams get discussed.
  // Stacked, not side by side. As bare siblings the two panels flowed into the
  // dialog's own row layout and sharing landed in a second column, detached
  // from the settings it belongs under.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <SettingsDialog open={true} onClose={onClose} variant="page" />
      <ProjectSharing />
    </div>
  );
}
