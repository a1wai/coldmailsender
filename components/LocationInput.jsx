'use client';

/**
 * components/LocationInput.jsx
 * ---------------------------------------------------------------------------
 * Location field with autocomplete, backed by OpenStreetMap's Nominatim.
 *
 * Picking a suggestion rather than free-typing matters: the search needs real
 * coordinates and a sensible radius, and "Troy" alone is ambiguous between
 * Michigan, New York and Turkey. The chosen place carries its own bounding
 * box, so a town searches a town-sized area and a region searches a region.
 *
 * Keyboard: ↑/↓ to move, Enter to pick, Escape to dismiss.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, MapPin, X } from 'lucide-react';

/** Long enough that a fast typist sends one request, not eight. */
const DEBOUNCE_MS = 350;

export default function LocationInput({ value, selected, onChange, onSelect, disabled, label = 'City / location' }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [error, setError] = useState(null);

  const containerRef = useRef(null);
  const debounceRef = useRef(null);
  const requestIdRef = useRef(0);

  // Close when clicking outside.
  useEffect(() => {
    const handler = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const fetchSuggestions = useCallback(async (query) => {
    // Every request carries an id; only the newest one is allowed to write
    // state, so a slow early response cannot overwrite a fast later one.
    const requestId = ++requestIdRef.current;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/places?q=${encodeURIComponent(query)}`);
      const data = await response.json();

      if (requestId !== requestIdRef.current) return;

      if (!data.ok) {
        setError(data.error || 'Lookup failed.');
        setSuggestions([]);
      } else {
        setSuggestions(data.places || []);
        setOpen(true);
        setHighlighted(data.places?.length ? 0 : -1);
      }
    } catch {
      if (requestId === requestIdRef.current) setError('Could not reach the location service.');
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  function handleChange(event) {
    const next = event.target.value;
    onChange(next);

    // Typing invalidates a previously picked place — the coordinates no
    // longer match what is in the box.
    if (selected) onSelect(null);

    clearTimeout(debounceRef.current);

    if (next.trim().length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    debounceRef.current = setTimeout(() => fetchSuggestions(next), DEBOUNCE_MS);
  }

  function choose(place) {
    onChange(place.short);
    onSelect(place);
    setOpen(false);
    setSuggestions([]);
  }

  function handleKeyDown(event) {
    if (!open || !suggestions.length) {
      if (event.key === 'ArrowDown' && value.trim().length >= 2) fetchSuggestions(value);
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((current) => (current + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((current) => (current - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === 'Enter' && highlighted >= 0) {
      event.preventDefault();
      choose(suggestions[highlighted]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <label className="label" htmlFor="location-input">
        {label}
      </label>

      <div className="relative">
        <MapPin
          size={15}
          className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 ${
            selected ? 'text-emerald-400' : 'text-slate-500'
          }`}
        />

        <input
          id="location-input"
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => suggestions.length && setOpen(true)}
          disabled={disabled}
          placeholder="Start typing a city…"
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls="location-suggestions"
          aria-autocomplete="list"
          className="input pl-9 pr-9"
        />

        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          {loading ? (
            <Loader2 size={14} className="animate-spin text-slate-500" />
          ) : selected ? (
            <Check size={14} className="text-emerald-400" />
          ) : value ? (
            <button
              type="button"
              onClick={() => {
                onChange('');
                onSelect(null);
                setSuggestions([]);
              }}
              className="text-slate-500 transition-colors hover:text-slate-300"
              aria-label="Clear location"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      </div>

      {open && suggestions.length > 0 && (
        <ul
          id="location-suggestions"
          role="listbox"
          className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-edge bg-white/[0.05] py-1 shadow-2xl shadow-black/50"
        >
          {suggestions.map((place, index) => (
            <li key={`${place.lat},${place.lon}`} role="option" aria-selected={index === highlighted}>
              <button
                type="button"
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => choose(place)}
                className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors ${
                  index === highlighted ? 'bg-brand-500/15' : 'hover:bg-white/[0.09]'
                }`}
              >
                <MapPin size={13} className="mt-0.5 shrink-0 text-slate-500" />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-slate-200">{place.short}</span>
                  <span className="block truncate text-[11px] text-slate-500">{place.label}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <p className="mt-1 text-xs text-amber-400">{error}</p>
      ) : selected ? (
        <p className="mt-1 text-xs text-emerald-400">Location set — ready to search.</p>
      ) : (
        <p className="mt-1 text-xs text-slate-500">Pick a suggestion so the search knows exactly where to look.</p>
      )}
    </div>
  );
}
