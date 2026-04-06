/**
 * Reusable tool filter tabs — consistent across Conversations, Memory, Dashboard.
 */

import React from 'react';
import './ToolTabs.css';

interface ToolTabsProps {
  value: string;
  onChange: (tool: string) => void;
  showAll?: boolean;
  allLabel?: string;
}

export default function ToolTabs({ value, onChange, showAll = true, allLabel = 'All' }: ToolTabsProps) {
  const tabs = [
    ...(showAll ? [{ key: '', label: allLabel }] : []),
    { key: 'claude', label: 'Claude' },
    { key: 'gemini', label: 'Gemini' },
    { key: 'opencode', label: 'OpenCode' },
  ];

  return (
    <div className="tool-tabs">
      {tabs.map(t => (
        <button
          key={t.key}
          className={`tool-tab tool-tab-${t.key || 'all'} ${value === t.key ? 'active' : ''}`}
          onClick={() => onChange(value === t.key && showAll ? '' : t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
