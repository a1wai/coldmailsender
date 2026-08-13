'use client';

/**
 * components/LeadTable.jsx
 * ---------------------------------------------------------------------------
 * The shared leads table, used by both the Lead Finder and the Campaign
 * Dashboard.
 *
 * ## Two layouts, not one scrolling table
 *
 * The previous version was a single 760px-wide table in an `overflow-x-auto`
 * box, so on anything narrower than a desktop the e-mail column — the one
 * column people actually came to read — sat off the right edge behind a
 * horizontal scrollbar. Now there are two renderings of the same data:
 *
 *   - md and up: a fixed-layout table whose lower-value columns (contact name,
 *     website) drop out as the viewport narrows, so what remains always fits.
 *   - below md: one card per lead, everything stacked and visible.
 *
 * Nothing scrolls sideways at any width.
 *
 * Other behaviour: inline editing of every field, search, status filters,
 * column sorting, and bulk selection with delete.
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
  // Set by /api/discover for a business that has a website but no published
  // address — the crawler's queue. Without an entry here it fell through to
  // "New", which claimed a lead was contactable when it was not.
  'needs-crawl': { label: 'Needs crawl', tone: 'neutral', Icon: Search },
  queued: { label: 'Queued', tone: 'neutral', Icon: CircleDashed },
  sending: { label: 'Sending', tone: 'brand', Icon: Loader2 },
  sent: { label: 'Sent', tone: 'success', Icon: Check },
  failed: { label: 'Failed', tone: 'error', Icon: X },
  skipped: { label: 'Skipped', tone: 'neutral', Icon: CircleDashed },
  unsubscribed: { label: 'Unsubscribed', tone: 'warn', Icon: X },
};

/**
 * `hide` is the breakpoint below which a column is dropped from the table.
 * Ordered by how much each one is worth when space is tight: the e-mail and
 * the business name always survive.
 */
const COLUMNS = [
  { key: 'business', label: 'Business', width: 'w-[26%]', placeholder: '—', hide: '' },
  { key: 'name', label: 'Contact', width: 'w-[14%]', placeholder: '—', hide: 'hidden xl:table-cell' },
  { key: 'website', label: 'Website', width: 'w-[22%]', placeholder: '—', hide: 'hidden lg:table-cell' },
  { key: 'email', label: 'E-mail', width: 'w-[30%]', placeholder: 'Add an address', hide: '' },
];

export default function LeadTable({
  leads = [],
  selectedIds = new Set(),
  onToggleSelect,
  onToggleSelectAll,
  onUpdateLead,
  onDeleteLead,
  onDeleteMany,
  showSelection = true,
  /**
   * The campaign can only send to a lead that has an address, so it greys out
   * the rest. The finder uses selection for bulk *deletion*, where a lead with
   * no address is exactly the one you want to tick.
   */
  selectionRequiresEmail = true,
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

  const canSelect = (lead) => !selectionRequiresEmail || Boolean(lead.email);

  const selectableIds = useMemo(
    () => visibleLeads.filter(canSelect).map((lead) => lead.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleLeads, selectionRequiresEmail],
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

  const commitEdit = (leadId, key, raw) => {
    onUpdateLead?.(leadId, { [key]: raw.trim() });
    setEditing(null);
  };

  if (!leads.length) {
    return <EmptyState icon={Inbox} title={emptyTitle}>{emptyHint}</EmptyState>;
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ------------------------------------------------------- toolbar */}
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

      {/* Bulk action bar — only present when there is something to act on, so
          it never takes up space it has not earned. */}
      {showSelection && selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-brand-400/30 bg-brand-500/[0.1] px-3.5 py-2.5">
          <span className="text-sm font-medium text-brand-100">
            {selectedIds.size} selected
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => onToggleSelectAll?.([...selectedIds], false)}
            className="btn-ghost btn-sm"
          >
            Clear
          </button>
          {onDeleteMany && (
            <button
              type="button"
              onClick={() => onDeleteMany([...selectedIds])}
              disabled={disabled}
              className="btn-danger btn-sm"
            >
              <Trash2 size={13} />
              Delete {selectedIds.size}
            </button>
          )}
        </div>
      )}

      {/* ================================================================= */}
      {/* md and up — table                                                 */}
      {/* ================================================================= */}
      <div className="hidden rounded-xl border border-edge bg-surface-sunken/40 md:block">
        {/* `table-fixed` is what makes the percentage widths bind, which is in
            turn what keeps long addresses truncating instead of pushing the
            table wider than its container. */}
        <table className="w-full table-fixed border-collapse">
          <thead>
            <tr className="border-b border-edge bg-white/[0.03]">
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
                    aria-label="Select all visible leads"
                  />
                </th>
              )}

              {COLUMNS.map((column) => (
                <th key={column.key} scope="col" className={`${column.width} ${column.hide} px-3 py-2.5 text-left`}>
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

              <th scope="col" className="w-[16%] px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
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
                  className={`border-b border-edge-soft transition-colors last:border-0 ${
                    isSelected ? 'bg-brand-500/[0.1]' : 'hover:bg-white/[0.03]'
                  }`}
                >
                  {showSelection && (
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => onToggleSelect?.(lead.id)}
                        disabled={disabled || !canSelect(lead)}
                        title={canSelect(lead) ? undefined : 'This lead has no e-mail address'}
                        className="h-4 w-4 cursor-pointer accent-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label={`Select ${lead.business || lead.email || 'lead'}`}
                      />
                    </td>
                  )}

                  {COLUMNS.map((column) => {
                    const cellKey = `${lead.id}:${column.key}`;
                    const value = lead[column.key] || '';

                    if (editing === cellKey && onUpdateLead) {
                      return (
                        <td key={column.key} className={`${column.hide} px-2 py-1`}>
                          <input
                            autoFocus
                            defaultValue={value}
                            className="input py-1 text-sm"
                            onBlur={(event) => commitEdit(lead.id, column.key, event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') event.currentTarget.blur();
                              if (event.key === 'Escape') setEditing(null);
                            }}
                          />
                        </td>
                      );
                    }

                    const display =
                      column.key === 'website' && value
                        ? String(value).replace(/^https?:\/\/(www\.)?/, '')
                        : value;

                    return (
                      <td key={column.key} className={`${column.hide} table-cell`}>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={disabled || !onUpdateLead}
                            onClick={() => onUpdateLead && setEditing(cellKey)}
                            // The full value on hover, since truncation is now
                            // the normal case rather than the exception.
                            title={value || (onUpdateLead ? 'Click to edit' : undefined)}
                            className={`min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left transition-colors ${
                              onUpdateLead && !disabled ? 'hover:bg-white/[0.09]' : 'cursor-default'
                            } ${value ? 'text-slate-200' : 'text-slate-600 italic'}`}
                          >
                            {display || column.placeholder}
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
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <Badge tone={meta.tone}>
                        <StatusIcon size={10} className={lead.status === 'sending' ? 'animate-spin' : ''} />
                        {meta.label}
                      </Badge>
                      {lead.error && (
                        <span className="truncate text-[10px] text-slate-500" title={lead.error}>
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

      {/* ================================================================= */}
      {/* below md — cards                                                  */}
      {/* ================================================================= */}
      <ul className="flex flex-col gap-2 md:hidden">
        {visibleLeads.map((lead) => {
          const isSelected = selectedIds.has(lead.id);
          const meta = STATUS_META[lead.status] || STATUS_META.new;
          const StatusIcon = meta.Icon;

          return (
            <li
              key={lead.id}
              className={`rounded-xl border p-3 transition-colors ${
                isSelected ? 'border-brand-400/40 bg-brand-500/[0.1]' : 'border-edge bg-surface-sunken/40'
              }`}
            >
              <div className="flex items-start gap-2.5">
                {showSelection && (
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggleSelect?.(lead.id)}
                    disabled={disabled || !canSelect(lead)}
                    className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={`Select ${lead.business || lead.email || 'lead'}`}
                  />
                )}

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100">
                    {lead.business || lead.name || '—'}
                  </p>

                  {/* `break-all`, not truncate: on a phone the address is the
                      whole point of the row, so it wraps rather than hides. */}
                  <p className={`mt-0.5 break-all text-xs ${lead.email ? 'text-brand-300' : 'text-slate-600 italic'}`}>
                    {lead.email || 'No e-mail found'}
                  </p>

                  {lead.website && (
                    <a
                      href={/^https?:\/\//i.test(lead.website) ? lead.website : `https://${lead.website}`}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="mt-1 inline-flex max-w-full items-center gap-1 text-[11px] text-slate-500 transition-colors hover:text-brand-400"
                    >
                      <span className="truncate">{lead.website.replace(/^https?:\/\/(www\.)?/, '')}</span>
                      <ExternalLink size={10} className="shrink-0" />
                    </a>
                  )}

                  {lead.name && lead.business && (
                    <p className="mt-1 truncate text-[11px] text-slate-500">{lead.name}</p>
                  )}

                  <div className="mt-2 flex items-center gap-2">
                    <Badge tone={meta.tone}>
                      <StatusIcon size={10} className={lead.status === 'sending' ? 'animate-spin' : ''} />
                      {meta.label}
                    </Badge>
                    {lead.error && (
                      <span className="min-w-0 truncate text-[10px] text-slate-500" title={lead.error}>
                        {lead.error}
                      </span>
                    )}
                  </div>
                </div>

                {onDeleteLead && (
                  <button
                    type="button"
                    onClick={() => onDeleteLead(lead.id)}
                    disabled={disabled}
                    className="shrink-0 rounded p-1.5 text-slate-600 transition-colors hover:bg-red-950/50 hover:text-red-400 disabled:opacity-40"
                    aria-label={`Remove ${lead.business || lead.email || 'lead'}`}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>
          Showing {visibleLeads.length} of {leads.length}
          {showSelection && selectedIds.size > 0 && (
            <span className="text-brand-400"> · {selectedIds.size} selected</span>
          )}
        </span>
        {onUpdateLead && <span className="hidden md:inline">Click any cell to edit it</span>}
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
          ? 'border-brand-400/40 bg-brand-500/15 text-brand-200'
          : 'border-edge bg-white/[0.04] text-slate-400 hover:border-edge-strong hover:bg-white/[0.07] hover:text-slate-200'
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
