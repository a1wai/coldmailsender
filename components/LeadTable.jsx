'use client';

/**
 * components/LeadTable.jsx
 * ---------------------------------------------------------------------------
 * The shared leads table, used by both the Lead Finder (Tab 1) and the
 * Campaign Dashboard (Tab 5).
 *
 * Features:
 *   - Select-all / individual checkboxes (Tab 5 needs them; Tab 1 hides them).
 *   - Inline editing of every field — scraped data is a starting point, and a
 *     personalised first line is what makes cold outreach work.
 *   - Search, status filter, and column sorting.
 *   - Live per-lead send status during a campaign.
 */

import { useMemo, useState } from 'react';
import {
  ArrowDownAZ,
  ArrowUpAZ,
  Check,
  ChevronsUpDown,
  CircleDashed,
  ExternalLink,
  Inbox,
  Loader2,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Badge, EmptyState } from './ui';

const STATUS_META = {
  new: { label: 'New', tone: 'brand', Icon: CircleDashed },
  'no-email': { label: 'No e-mail', tone: 'warn', Icon: TriangleAlert },
  queued: { label: 'Queued', tone: 'neutral', Icon: CircleDashed },
  sending: { label: 'Sending', tone: 'brand', Icon: Loader2 },
  sent: { label: 'Sent', tone: 'success', Icon: Check },
  failed: { label: 'Failed', tone: 'error', Icon: X },
  skipped: { label: 'Skipped', tone: 'neutral', Icon: CircleDashed },
};

const COLUMNS = [
  { key: 'name', label: 'Name', width: 'w-[15%]', editable: true, placeholder: '—' },
  { key: 'business', label: 'Business', width: 'w-[22%]', editable: true, placeholder: '—' },
  { key: 'website', label: 'Website', width: 'w-[22%]', editable: true, placeholder: '—' },
  { key: 'email', label: 'E-mail', width: 'w-[26%]', editable: true, placeholder: 'Add an address' },
];

export default function LeadTable({
  leads = [],
  selectedIds = new Set(),
  onToggleSelect,
  onToggleSelectAll,
  onUpdateLead,
  onDeleteLead,
  showSelection = true,
  emptyTitle = 'No leads yet',
  emptyHint = 'Scrape a list of sites in the Lead Finder tab, or import a JSON backup.',
  disabled = false,
}) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sort, setSort] = useState({ key: null, direction: 'asc' });
  const [editing, setEditing] = useState(null); // `${leadId}:${columnKey}`

  const statusCounts = useMemo(() => {
    const counts = {};
    for (const lead of leads) counts[lead.status || 'new'] = (counts[lead.status || 'new'] || 0) + 1;
    return counts;
  }, [leads]);

  const visibleLeads = useMemo(() => {
    const needle = query.trim().toLowerCase();

    let result = leads.filter((lead) => {
      if (statusFilter !== 'all' && (lead.status || 'new') !== statusFilter) return false;
      if (!needle) return true;
      return [lead.name, lead.business, lead.website, lead.email]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });

    if (sort.key) {
      const direction = sort.direction === 'asc' ? 1 : -1;
      result = [...result].sort((a, b) => {
        const left = String(a[sort.key] || '').toLowerCase();
        const right = String(b[sort.key] || '').toLowerCase();
        // Empty values always sort last, regardless of direction — a blank
        // e-mail column at the top is never what the user wanted.
        if (!left && right) return 1;
        if (left && !right) return -1;
        return left.localeCompare(right) * direction;
      });
    }

    return result;
  }, [leads, query, statusFilter, sort]);

  const selectableIds = useMemo(
    () => visibleLeads.filter((lead) => lead.email).map((lead) => lead.id),
    [visibleLeads],
  );

  const allVisibleSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = selectableIds.some((id) => selectedIds.has(id));

  const toggleSort = (key) => {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' },
    );
  };

  if (!leads.length) {
    return <EmptyState icon={Inbox} title={emptyTitle}>{emptyHint}</EmptyState>;
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, business, domain…"
            className="input pl-9"
            aria-label="Search leads"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <FilterPill active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>
            All {leads.length}
          </FilterPill>
          {Object.entries(statusCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([status, count]) => (
              <FilterPill key={status} active={statusFilter === status} onClick={() => setStatusFilter(status)}>
                {STATUS_META[status]?.label || status} {count}
              </FilterPill>
            ))}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-ink-700">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            <tr className="border-b border-ink-700 bg-ink-800/60">
              {showSelection && (
                <th scope="col" className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    ref={(node) => {
                      // Indeterminate is a DOM property, not an attribute.
                      if (node) node.indeterminate = !allVisibleSelected && someVisibleSelected;
                    }}
                    onChange={() => onToggleSelectAll?.(selectableIds, !allVisibleSelected)}
                    disabled={disabled || !selectableIds.length}
                    className="h-4 w-4 cursor-pointer accent-brand-500 disabled:cursor-not-allowed"
                    aria-label="Select all visible leads with an e-mail address"
                  />
                </th>
              )}

              {COLUMNS.map((column) => (
                <th key={column.key} scope="col" className={`${column.width} px-3 py-2.5 text-left`}>
                  <button
                    type="button"
                    onClick={() => toggleSort(column.key)}
                    className="inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-slate-400 transition-colors hover:text-slate-200"
                  >
                    {column.label}
                    <SortIcon active={sort.key === column.key} direction={sort.direction} />
                  </button>
                </th>
              ))}

              <th scope="col" className="px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
                Status
              </th>
              {onDeleteLead && <th scope="col" className="w-10 px-3 py-2.5" />}
            </tr>
          </thead>

          <tbody>
            {visibleLeads.map((lead) => {
              const isSelected = selectedIds.has(lead.id);
              const meta = STATUS_META[lead.status] || STATUS_META.new;
              const StatusIcon = meta.Icon;

              return (
                <tr
                  key={lead.id}
                  className={`border-b border-ink-800 transition-colors last:border-0 ${
                    isSelected ? 'bg-brand-500/[0.07]' : 'hover:bg-ink-800/40'
                  }`}
                >
                  {showSelection && (
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => onToggleSelect?.(lead.id)}
                        disabled={disabled || !lead.email}
                        title={lead.email ? undefined : 'This lead has no e-mail address'}
                        className="h-4 w-4 cursor-pointer accent-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label={`Select ${lead.business || lead.email || 'lead'}`}
                      />
                    </td>
                  )}

                  {COLUMNS.map((column) => {
                    const cellKey = `${lead.id}:${column.key}`;
                    const value = lead[column.key] || '';
                    const isEditing = editing === cellKey;

                    if (isEditing && onUpdateLead) {
                      return (
                        <td key={column.key} className="px-2 py-1">
                          <input
                            autoFocus
                            defaultValue={value}
                            className="input py-1 text-sm"
                            onBlur={(event) => {
                              onUpdateLead(lead.id, { [column.key]: event.target.value.trim() });
                              setEditing(null);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') event.currentTarget.blur();
                              if (event.key === 'Escape') setEditing(null);
                            }}
                          />
                        </td>
                      );
                    }

                    return (
                      <td key={column.key} className="table-cell">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={disabled || !onUpdateLead}
                            onClick={() => onUpdateLead && setEditing(cellKey)}
                            title={onUpdateLead ? 'Click to edit' : undefined}
                            className={`min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left transition-colors ${
                              onUpdateLead && !disabled ? 'hover:bg-ink-700' : 'cursor-default'
                            } ${value ? 'text-slate-200' : 'text-slate-600 italic'}`}
                          >
                            {column.key === 'website' && value
                              ? String(value).replace(/^https?:\/\/(www\.)?/, '')
                              : value || column.placeholder}
                          </button>

                          {column.key === 'website' && value && (
                            <a
                              href={/^https?:\/\//i.test(value) ? value : `https://${value}`}
                              target="_blank"
                              rel="noopener noreferrer nofollow"
                              className="shrink-0 text-slate-500 transition-colors hover:text-brand-400"
                              title="Open in a new tab"
                            >
                              <ExternalLink size={12} />
                            </a>
                          )}
                        </div>
                      </td>
                    );
                  })}

                  <td className="table-cell">
                    <div className="flex flex-col gap-0.5">
                      <Badge tone={meta.tone}>
                        <StatusIcon size={10} className={lead.status === 'sending' ? 'animate-spin' : ''} />
                        {meta.label}
                      </Badge>
                      {lead.error && (
                        <span className="max-w-[200px] truncate text-[10px] text-slate-500" title={lead.error}>
                          {lead.error}
                        </span>
                      )}
                    </div>
                  </td>

                  {onDeleteLead && (
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => onDeleteLead(lead.id)}
                        disabled={disabled}
                        className="rounded p-1 text-slate-600 transition-colors hover:bg-red-950/50 hover:text-red-400 disabled:opacity-40"
                        aria-label={`Remove ${lead.business || lead.email || 'lead'}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>
          Showing {visibleLeads.length} of {leads.length}
          {showSelection && selectedIds.size > 0 && (
            <span className="text-brand-400"> · {selectedIds.size} selected</span>
          )}
        </span>
        {onUpdateLead && <span>Click any cell to edit it</span>}
      </div>
    </div>
  );
}

function FilterPill({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
        active
          ? 'border-brand-500/40 bg-brand-500/15 text-brand-300'
          : 'border-ink-600 bg-ink-800 text-slate-400 hover:border-ink-500 hover:text-slate-200'
      }`}
    >
      {children}
    </button>
  );
}

function SortIcon({ active, direction }) {
  if (!active) return <ChevronsUpDown size={11} className="opacity-40" />;
  return direction === 'asc' ? <ArrowUpAZ size={11} /> : <ArrowDownAZ size={11} />;
}
