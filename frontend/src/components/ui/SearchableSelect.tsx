import { useEffect, useId, useMemo, useRef, useState } from 'react';
import './searchable-select.css';

export interface SearchableSelectOption {
  value: string;
  label: string;
  description?: string;
  keywords?: string;
}

interface SearchableSelectProps {
  value: string;
  options: SearchableSelectOption[];
  onChange: (value: string) => void;
  placeholder: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  ariaLabel?: string;
  maxResults?: number;
  clearLabel?: string;
  moreResultsLabel?: string;
  loading?: boolean;
  loadingMessage?: string;
  onSearchChange?: (query: string) => void;
}

function normalize(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();
}

export default function SearchableSelect({
  value,
  options,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyMessage = 'No hay resultados.',
  disabled = false,
  ariaLabel,
  maxResults = 100,
  clearLabel = 'Clear selection',
  moreResultsLabel = '{count} more result(s). Type more to narrow the list.',
  loading = false,
  loadingMessage = 'Loading…',
  onSearchChange,
}: SearchableSelectProps) {
  const generatedId = useId();
  const listId = `${generatedId}-options`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const selected = useMemo(() => options.find(option => option.value === value), [options, value]);
  const normalizedQuery = normalize(query);
  const matches = useMemo(() => {
    const matches = normalizedQuery
      ? options.filter(option => normalize(`${option.label} ${option.description ?? ''} ${option.keywords ?? ''}`).includes(normalizedQuery))
      : options;
    return { visible: matches.slice(0, maxResults), hidden: Math.max(0, matches.length - maxResults) };
  }, [maxResults, normalizedQuery, options]);
  const filtered = matches.visible;
  const activePosition = Math.min(activeIndex, Math.max(filtered.length - 1, 0));

  useEffect(() => {
    if (!open || loading || !filtered[activePosition]) return;
    optionRefs.current[activePosition]?.scrollIntoView({ block: 'nearest' });
  }, [activePosition, filtered, loading, open]);

  const close = () => {
    setOpen(false);
    setQuery('');
    onSearchChange?.('');
  };

  const choose = (nextValue: string) => {
    onChange(nextValue);
    close();
  };

  const visibleValue = open ? query : (selected?.label ?? '');
  const hiddenCount = matches.hidden;

  return (
    <div
      ref={rootRef}
      className={`searchable-select${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`}
      onBlur={event => {
        if (!rootRef.current?.contains(event.relatedTarget as Node)) close();
      }}
    >
      <div className="searchable-select-input-wrap">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-4-4" />
        </svg>
        <input
          ref={inputRef}
          className="form-input searchable-select-input"
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && !loading && filtered[activePosition] ? `${listId}-${activePosition}` : undefined}
          autoComplete="off"
          disabled={disabled}
          value={visibleValue}
          placeholder={open ? (searchPlaceholder ?? placeholder) : placeholder}
          onFocus={event => {
            setOpen(true);
            setQuery('');
            setActiveIndex(0);
            onSearchChange?.('');
            window.requestAnimationFrame(() => event.currentTarget.select());
          }}
          onChange={event => {
            if (value) onChange('');
            setQuery(event.target.value);
            onSearchChange?.(event.target.value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              if (!open) setOpen(true);
              else setActiveIndex(Math.min(activePosition + 1, Math.max(filtered.length - 1, 0)));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              if (!open) setOpen(true);
              else setActiveIndex(Math.max(activePosition - 1, 0));
            } else if (event.key === 'Enter' && open && !loading && filtered[activePosition]) {
              event.preventDefault();
              choose(filtered[activePosition].value);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              close();
              inputRef.current?.blur();
            }
          }}
        />
        {value && !disabled && (
          <button
            type="button"
            className="searchable-select-clear"
            aria-label={clearLabel}
            onMouseDown={event => event.preventDefault()}
            onClick={() => {
              onChange('');
              setQuery('');
              onSearchChange?.('');
              setOpen(true);
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        )}
      </div>

      {open && !disabled && (
        <div id={listId} className="searchable-select-menu" role="listbox" aria-busy={loading}>
          {loading && <div className="searchable-select-empty" role="status">{loadingMessage}</div>}
          {!loading && filtered.length === 0 && <div className="searchable-select-empty">{emptyMessage}</div>}
          {!loading && filtered.map((option, index) => (
            <button
              ref={element => { optionRefs.current[index] = element; }}
              id={`${listId}-${index}`}
              key={option.value}
              type="button"
              tabIndex={-1}
              role="option"
              aria-selected={option.value === value}
              className={`searchable-select-option${index === activePosition ? ' is-active' : ''}${option.value === value ? ' is-selected' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={event => event.preventDefault()}
              onClick={() => choose(option.value)}
            >
              <span>{option.label}</span>
              {option.description && <small>{option.description}</small>}
            </button>
          ))}
          {!loading && hiddenCount > 0 && (
            <div className="searchable-select-more">{moreResultsLabel.replace('{count}', String(hiddenCount))}</div>
          )}
        </div>
      )}
    </div>
  );
}
