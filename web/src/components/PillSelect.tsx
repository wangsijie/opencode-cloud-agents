import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, ChevronDownIcon, SearchIcon } from './icons';

export interface PillOption {
  value: string;
  label: string;
  /** Extra text the search matches but the row does not show. */
  keywords?: string;
}

/**
 * The composer's pickers, drawn rather than native.
 *
 * A `<select>` cannot hold a search field or a button, and both pickers wanted
 * one of those, so the menu is ours: one keyboard model, one outside-click
 * close, one panel. Closed, it is still a pill in the composer row.
 *
 * `search` turns the filter on, and `action` puts a control beside it — that is
 * where the repository refresh lives, because it is an action on the list and
 * only worth reaching for while looking at it.
 */
export function PillSelect({
  options,
  value,
  ariaLabel,
  placeholder,
  loadingLabel,
  disabled,
  loading,
  search,
  searchPlaceholder,
  emptyLabel,
  action,
  footer,
  onChange
}: {
  options?: PillOption[];
  value: string;
  ariaLabel: string;
  placeholder?: string;
  loadingLabel?: string;
  disabled?: boolean;
  loading?: boolean;
  search?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
  action?: ReactNode;
  footer?: ReactNode;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options?.find((option) => option.value === value);
  const label = loading ? (loadingLabel ?? 'Loading…') : (selected?.label ?? placeholder);

  const matches = useMemo(() => {
    const needle = search ? query.trim().toLowerCase() : '';
    if (!options) {
      return [];
    }
    if (!needle) {
      return options;
    }
    return options.filter((option) =>
      `${option.label} ${option.keywords ?? ''}`.toLowerCase().includes(needle)
    );
  }, [options, query, search]);

  // Opening starts on the current choice, and every keystroke re-anchors on the
  // best remaining match, so Enter always takes what the list shows first.
  useEffect(() => {
    if (!open) {
      return;
    }
    const index = matches.findIndex((option) => option.value === value);
    setActive(query ? 0 : Math.max(index, 0));
  }, [open, query]);

  useEffect(() => {
    if (!open) {
      return;
    }
    searchRef.current?.focus();
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  useEffect(() => {
    if (open) {
      listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
    }
  }, [open, active]);

  function dismiss() {
    setOpen(false);
    setQuery('');
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (matches.length === 0) {
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => (current + step + matches.length) % matches.length);
      return;
    }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const option = matches[active];
      if (option) {
        onChange(option.value);
        dismiss();
      }
    }
  }

  return (
    <div className="pill-menu" ref={rootRef}>
      <button
        className="pill-select pill-menu-button"
        type="button"
        disabled={disabled || loading}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? dismiss() : setOpen(true))}
      >
        <span className="pill-menu-label">{label}</span>
        <ChevronDownIcon />
      </button>

      {open ? (
        // The panel owns the keys for everything inside it, including the
        // search field, so arrows and Enter mean the same wherever focus sits.
        <div className="pill-menu-panel" onKeyDown={onKeyDown}>
          {search || action ? (
            <div className="pill-menu-search">
              {search ? (
                <>
                  <SearchIcon />
                  <input
                    ref={searchRef}
                    type="text"
                    value={query}
                    placeholder={searchPlaceholder}
                    aria-label={searchPlaceholder ?? `Search ${ariaLabel}`}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </>
              ) : (
                <span className="spacer" />
              )}
              {action}
            </div>
          ) : null}

          <div className="pill-menu-list" role="listbox" ref={listRef}>
            {matches.map((option, index) => (
              <button
                key={option.value}
                className={`pill-menu-option${index === active ? ' active' : ''}`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                onPointerEnter={() => setActive(index)}
                onClick={() => {
                  onChange(option.value);
                  dismiss();
                }}
              >
                <span className="pill-menu-option-label">{option.label}</span>
                {option.value === value ? <CheckIcon /> : null}
              </button>
            ))}
            {matches.length === 0 ? (
              <p className="pill-menu-empty muted">{emptyLabel ?? 'Nothing to pick'}</p>
            ) : null}
          </div>

          {footer}
        </div>
      ) : null}
    </div>
  );
}
