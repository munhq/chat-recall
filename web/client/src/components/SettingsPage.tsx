/**
 * SettingsPage — full-page rendering of the settings UI.
 *
 * Same content as SettingsDialog (which still exists for any callers that
 * want a modal), just rendered inline as a page. The shared component knows
 * which mode it's in via the `variant` prop.
 */
import React from 'react';
import SettingsDialog from './SettingsDialog';

export default function SettingsPage({ onClose }: { onClose: () => void }) {
  // open=true is a no-op in 'page' mode but kept for the shared signature;
  // the page version uses route mounting (App.tsx renders us only when
  // view === 'settings'), so we never need to gate on `open`.
  return <SettingsDialog open={true} onClose={onClose} variant="page" />;
}
