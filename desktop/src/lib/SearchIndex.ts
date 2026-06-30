// ---------------------------------------------------------------------------
// SearchIndex
// A lightweight in-memory search index for the command palette.
// Supports two kinds of entries: pages (navigation targets) and actions
// (executable callbacks). Querying matches against title and id, case-folded.
// ---------------------------------------------------------------------------

export type SearchResultType = 'page' | 'action' | 'session' | 'agent';

export interface SearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  subtitle?: string;
  icon: string;
}

export interface PageEntry {
  id: string;
  label: string;
  icon: string;
}

export interface ActionEntry {
  id: string;
  title: string;
  icon: string;
  subtitle?: string;
}

export class SearchIndex {
  private pages: SearchResult[] = [];
  private actions: SearchResult[] = [];

  setPages(pages: PageEntry[]): void {
    this.pages = pages.map((p) => ({
      type: 'page',
      id: p.id,
      title: p.label,
      icon: p.icon,
      subtitle: 'Navigate',
    }));
  }

  setActions(actions: ActionEntry[]): void {
    this.actions = actions.map((a) => ({
      type: 'action',
      ...a,
    }));
  }

  /**
   * Query the index. Returns all entries when `text` is empty, otherwise
   * entries whose title or id contains the query (case-insensitive).
   */
  query(text: string): SearchResult[] {
    if (!text.trim()) return [...this.pages, ...this.actions];
    const q = text.toLowerCase();
    return [...this.pages, ...this.actions].filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q),
    );
  }
}

export default SearchIndex;
