import { useId, useMemo, useState } from 'react';
import './task-note.css';

type TaskNoteProps = {
  note: string | null | undefined;
};

type NoteItemState = 'success' | 'failure' | 'warning' | 'pending' | null;

type NoteItem = {
  text: string;
  state: NoteItemState;
  order?: number;
};

type NoteBlock =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'unordered'; items: NoteItem[] }
  | { kind: 'ordered'; items: NoteItem[]; start: number };

const PREVIEW_ROWS = 6;
const PREVIEW_CHARACTERS = 720;

function parseListItem(line: string): { kind: 'unordered' | 'ordered'; item: NoteItem; start?: number } | null {
  const checkbox = line.match(/^\s*[-*\u2022]\s+\[([ xX\u2713\u2714!\u2717\u2715\u00d7])\]\s+(.+?)\s*$/u);
  if (checkbox) {
    const marker = checkbox[1];
    const state: NoteItemState = /[xX\u2713\u2714]/u.test(marker)
      ? 'success'
      : /[!\u2717\u2715\u00d7]/u.test(marker)
        ? 'failure'
        : 'pending';
    return { kind: 'unordered', item: { text: checkbox[2], state } };
  }

  const status = line.match(/^\s*(\u2705|\u274c|\u26a0\ufe0f?|[\u2713\u2714\u2717\u2715\u00d7])\s*(.+?)\s*$/u);
  if (status) {
    const marker = status[1];
    return {
      kind: 'unordered',
      item: {
        text: status[2],
        state: /[\u2705\u2713\u2714]/u.test(marker)
          ? 'success'
          : /\u26a0/u.test(marker)
            ? 'warning'
            : 'failure',
      },
    };
  }

  const namedStatus = line.match(/^\s*(OK|SUCCESS|FAILED|FAIL|ERROR|WARNING|WARN)(?:\s*[:-]\s*|\s+)(.+?)\s*$/iu);
  if (namedStatus) {
    const marker = namedStatus[1].toUpperCase();
    return {
      kind: 'unordered',
      item: {
        text: namedStatus[2],
        state: marker === 'OK' || marker === 'SUCCESS'
          ? 'success'
          : marker === 'WARNING' || marker === 'WARN'
            ? 'warning'
            : 'failure',
      },
    };
  }

  const ordered = line.match(/^\s*(\d+)[.)]\s+(.+?)\s*$/u);
  if (ordered) {
    return {
      kind: 'ordered',
      start: Number(ordered[1]),
      item: { text: ordered[2], state: null, order: Number(ordered[1]) },
    };
  }

  const unordered = line.match(/^\s*[-*\u2022]\s+(.+?)\s*$/u);
  if (unordered) {
    return { kind: 'unordered', item: { text: unordered[1], state: null } };
  }

  return null;
}

function parseNote(note: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let paragraphLines: string[] = [];
  let list: Extract<NoteBlock, { kind: 'unordered' | 'ordered' }> | null = null;

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      blocks.push({ kind: 'paragraph', lines: paragraphLines });
      paragraphLines = [];
    }
  };

  const flushList = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };

  for (const rawLine of note.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const listItem = parseListItem(line);
    if (!listItem) {
      flushList();
      paragraphLines.push(line);
      continue;
    }

    flushParagraph();
    if (!list || list.kind !== listItem.kind) {
      flushList();
      list = listItem.kind === 'ordered'
        ? { kind: 'ordered', items: [], start: listItem.start ?? 1 }
        : { kind: 'unordered', items: [] };
    }
    list.items.push(listItem.item);
  }

  flushParagraph();
  flushList();
  return blocks;
}

function noteRowCount(blocks: NoteBlock[]): number {
  return blocks.reduce((total, block) => (
    total + (block.kind === 'paragraph' ? block.lines.length : block.items.length)
  ), 0);
}

function previewText(text: string, availableCharacters: number): { text: string; clipped: boolean } {
  if (text.length <= availableCharacters) return { text, clipped: false };
  const visibleCharacters = Math.max(1, availableCharacters - 1);
  return { text: `${text.slice(0, visibleCharacters).trimEnd()}\u2026`, clipped: true };
}

function buildPreview(blocks: NoteBlock[]): NoteBlock[] {
  const preview: NoteBlock[] = [];
  let rows = 0;
  let characters = 0;
  let complete = false;

  for (const block of blocks) {
    if (rows >= PREVIEW_ROWS || characters >= PREVIEW_CHARACTERS || complete) break;

    if (block.kind === 'paragraph') {
      const lines: string[] = [];
      for (const line of block.lines) {
        if (rows >= PREVIEW_ROWS || characters >= PREVIEW_CHARACTERS) break;
        const clippedLine = previewText(line, PREVIEW_CHARACTERS - characters);
        lines.push(clippedLine.text);
        rows += 1;
        characters += clippedLine.text.length;
        if (clippedLine.clipped) {
          complete = true;
          break;
        }
      }
      if (lines.length > 0) preview.push({ kind: 'paragraph', lines });
      continue;
    }

    const items: NoteItem[] = [];
    for (const item of block.items) {
      if (rows >= PREVIEW_ROWS || characters >= PREVIEW_CHARACTERS) break;
      const clippedItem = previewText(item.text, PREVIEW_CHARACTERS - characters);
      items.push({ ...item, text: clippedItem.text });
      rows += 1;
      characters += clippedItem.text.length;
      if (clippedItem.clipped) {
        complete = true;
        break;
      }
    }
    if (items.length > 0) {
      preview.push(block.kind === 'ordered'
        ? { kind: 'ordered', items, start: block.start }
        : { kind: 'unordered', items });
    }
  }

  return preview;
}

function StateIcon({ state }: { state: Exclude<NoteItemState, null> }) {
  const symbol = state === 'success' ? '\u2713' : state === 'failure' ? '\u2717' : state === 'warning' ? '!' : '';
  return <span className={`task-note__state task-note__state--${state}`} aria-hidden="true">{symbol}</span>;
}

function NoteBlocks({ blocks }: { blocks: NoteBlock[] }) {
  return blocks.map((block, blockIndex) => {
    if (block.kind === 'paragraph') {
      return (
        <p className="task-note__paragraph" key={`paragraph-${blockIndex}`}>
          {block.lines.join('\n')}
        </p>
      );
    }

    const hasStates = block.items.some(item => item.state !== null);
    const items = block.items.map((item, itemIndex) => (
      <li
        className={item.state ? `task-note__item task-note__item--${item.state}` : 'task-note__item'}
        key={`${blockIndex}-${itemIndex}-${item.text}`}
        value={block.kind === 'ordered' ? item.order : undefined}
      >
        {hasStates && (item.state
          ? <StateIcon state={item.state} />
          : <span className="task-note__state task-note__state--neutral" aria-hidden="true">•</span>)}
        <span>{item.text}</span>
      </li>
    ));

    if (block.kind === 'ordered') {
      return <ol className="task-note__list task-note__list--ordered" start={block.start} key={`ordered-${blockIndex}`}>{items}</ol>;
    }

    return (
      <ul className={`task-note__list${hasStates ? ' task-note__list--states' : ''}`} key={`unordered-${blockIndex}`}>
        {items}
      </ul>
    );
  });
}

export default function TaskNote({ note }: TaskNoteProps) {
  const normalizedNote = note?.trim() ?? '';
  const contentId = useId();
  const [expandedNote, setExpandedNote] = useState<string | null>(null);
  const blocks = useMemo(() => normalizedNote ? parseNote(normalizedNote) : [], [normalizedNote]);
  const previewBlocks = useMemo(() => buildPreview(blocks), [blocks]);
  const metrics = useMemo(() => {
    let successes = 0;
    let failures = 0;
    for (const block of blocks) {
      if (block.kind === 'paragraph') continue;
      for (const item of block.items) {
        if (item.state === 'success') successes += 1;
        if (item.state === 'failure') failures += 1;
      }
    }
    return { successes, failures, rows: noteRowCount(blocks) };
  }, [blocks]);

  if (!normalizedNote) return <span className="text-muted">—</span>;

  const expanded = expandedNote === normalizedNote;
  const longNote = metrics.rows > PREVIEW_ROWS || normalizedNote.length > PREVIEW_CHARACTERS;
  const displayedBlocks = longNote && !expanded ? previewBlocks : blocks;
  const detailSize = metrics.rows > PREVIEW_ROWS
    ? `${metrics.rows.toLocaleString('es-MX')} renglones`
    : `${normalizedNote.length.toLocaleString('es-MX')} caracteres`;

  return (
    <div className="task-note">
      {(metrics.successes > 0 || metrics.failures > 0) && (
        <div className="task-note__summary" aria-label="Resumen de resultados">
          {metrics.successes > 0 && <span className="task-note__count task-note__count--success">✓ {metrics.successes.toLocaleString('es-MX')} {metrics.successes === 1 ? 'éxito' : 'éxitos'}</span>}
          {metrics.failures > 0 && <span className="task-note__count task-note__count--failure">✗ {metrics.failures.toLocaleString('es-MX')} {metrics.failures === 1 ? 'falla' : 'fallas'}</span>}
        </div>
      )}
      <div className={`task-note__content${longNote && !expanded ? ' task-note__content--preview' : ''}`} id={contentId}>
        <NoteBlocks blocks={displayedBlocks} />
      </div>
      {longNote && (
        <button
          type="button"
          className="task-note__toggle"
          aria-controls={contentId}
          aria-expanded={expanded}
          onClick={() => setExpandedNote(expanded ? null : normalizedNote)}
        >
          <span>{expanded ? 'Mostrar menos' : 'Ver detalle completo'}</span>
          {!expanded && <small>{detailSize}</small>}
          <span className="task-note__toggle-icon" aria-hidden="true">{expanded ? '\u2191' : '\u2193'}</span>
        </button>
      )}
    </div>
  );
}
