// wiki.mjs — 轻量倒排索引 + 检索
// 对照 Python wiki.py

const _WORD = /[A-Za-z_][A-Za-z0-9_\-./]{2,}/g;

export class SessionWiki {
  constructor(slices) {
    this.slices = {};
    for (const s of slices) this.slices[s.slice_id] = s;

    this.byCluster = {};  // cluster → [slice_id]
    this.byKeyword = {};  // keyword → Set(slice_id)
    for (const s of slices) {
      for (const c of s.clusters) {
        if (!this.byCluster[c]) this.byCluster[c] = [];
        this.byCluster[c].push(s.slice_id);
      }
      for (const kw of this._keywords(s)) {
        if (!this.byKeyword[kw]) this.byKeyword[kw] = new Set();
        this.byKeyword[kw].add(s.slice_id);
      }
    }
  }

  _keywords(s) {
    const kws = new Set();
    for (const e of s.events) {
      if (e.tool_name === "Bash") {
        const toks = (e.command.match(_WORD) || []).slice(0, 6);
        for (const t of toks) kws.add(t.toLowerCase());
      }
      for (const p of (e.file_paths || [])) {
        kws.add(p.toLowerCase());
        kws.add(p.split("/").pop().toLowerCase());
      }
      if (e.is_error && e.tool_output) {
        const toks = (e.tool_output.match(_WORD) || []).slice(0, 20);
        for (const t of toks) kws.add(t.toLowerCase());
      }
    }
    return kws;
  }

  retrieve(cluster, queryTerms = null, topK = 8) {
    let ids = new Set(this.byCluster[cluster] || []);
    if (queryTerms && queryTerms.length > 0) {
      const hit = new Set();
      for (const term of queryTerms) {
        const low = String(term).toLowerCase();
        if (this.byKeyword[low]) {
          for (const id of this.byKeyword[low]) hit.add(id);
        }
      }
      const inter = new Set([...ids].filter(x => hit.has(x)));
      if (inter.size > 0) ids = inter;
    }
    const chosen = [...ids].map(i => this.slices[i]).filter(s => s).sort((a, b) => a.start_seq - b.start_seq);
    return chosen.slice(0, topK);
  }

  clusterSlices(cluster) {
    return (this.byCluster[cluster] || []).map(i => this.slices[i]).filter(s => s);
  }
}
