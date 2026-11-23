import { useState } from 'react';
import GeneratorTab from './components/GeneratorTab';
import DocumentManagerTab from './components/DocumentManagerTab';
import { SITES, SITE_OPTIONS, type SiteConfig, type SiteId } from './sites';

type Tab = 'generate' | 'manage';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('generate');
  const [selectedSiteId, setSelectedSiteId] = useState<SiteId>('express');
  const site = SITES[selectedSiteId];
  // Mount both tabs up front (only the active one is shown) so their React state
  // survives tab switches AND the Document Manager can pre-warm its scan on page
  // load — its table is ready before the author first opens that tab.
  const [mountedTabs, setMountedTabs] = useState<Set<Tab>>(() => new Set<Tab>(['generate', 'manage']));

  function selectTab(tab: Tab) {
    setActiveTab(tab);
    setMountedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="p-6 flex flex-col gap-4">
        <h1 className="text-2xl font-semibold text-gray-900">PDP Document Generator</h1>
        <SiteSelector site={site} onChange={setSelectedSiteId} />

        <div className="flex gap-1.5">
          <TabButton active={activeTab === 'generate'} onClick={() => selectTab('generate')}>
            Generate
          </TabButton>
          <TabButton active={activeTab === 'manage'} onClick={() => selectTab('manage')}>
            Document Manager
          </TabButton>
        </div>

        {mountedTabs.has('generate') && (
          <div className={activeTab === 'generate' ? 'flex flex-col gap-4' : 'hidden'}>
            <GeneratorTab key={site.id} site={site} />
          </div>
        )}
        {mountedTabs.has('manage') && (
          <div className={activeTab === 'manage' ? undefined : 'hidden'}>
            <DocumentManagerTab key={site.id} site={site} />
          </div>
        )}
      </div>
    </div>
  );
}

function SiteSelector({ site, onChange }: { site: SiteConfig; onChange: (id: SiteId) => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3">
      <div className="min-w-28">
        <p className="text-sm font-medium text-gray-900">Target site</p>
        <p className="text-xs text-gray-500">Switching clears current results.</p>
      </div>
      <div role="group" aria-label="Target site" className="flex rounded-lg border border-gray-300 overflow-hidden">
        {SITE_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={site.id === option.id}
            onClick={() => onChange(option.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
              site.id === option.id
                ? 'bg-gray-900 text-white'
                : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <code className="ml-auto text-xs text-gray-500">{site.daRoot}</code>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2 rounded-full text-sm font-medium cursor-pointer transition-colors ${
        active
          ? 'bg-gray-900 text-white'
          : 'bg-white text-gray-500 border border-gray-200 hover:bg-gray-50'
      }`}
    >
      {children}
    </button>
  );
}
