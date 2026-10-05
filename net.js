// Data layer — the app talks to Supabase directly.
//
// load() fetches everything and assembles window.FINANCE_DATA in exactly the
// shape the screens were built against (this is a port of server/state.py).
// Writes go through database functions so snapshot rules live in one place.
// The last good state is cached in localStorage so the app opens offline.
(function () {
  const cfg = window.NET_CONFIG || {};
  const CACHE_KEY = "net.state.v1";
  const STOCK_LOGOS = new Set(window.NET_STOCK_LOGOS || []);   // web/logos/stocks/index.js
  const LOGOS = new Set(["cimb", "cimb_prs", "epf", "gx", "hlb", "hlb_bank", "hsbc", "ibkr", "mbb",
                         "moomoo", "ryt_bank", "tiger", "versa", "webull", "wise"]);
  // Per-family ramps, darkest first (mirror of tokens.css): largest balance gets the darkest step.
  const TYPE_RAMP = {
    investment: ["#064e3b", "#166534", "#15803d", "#16a34a", "#22c55e", "#4ade80", "#86efac", "#bbf7d0"],
    bank:       ["#1e3a8a", "#1d4ed8", "#2563eb", "#3b82f6", "#60a5fa", "#93c5fd", "#bfdbfe", "#dbeafe"],
    retirement: ["#475569", "#64748b", "#94a3b8", "#cbd5e1"],
    property:   ["#0d9488", "#14b8a6", "#2dd4bf", "#5eead4"],
    other:      ["#d97706", "#f59e0b", "#fbbf24", "#fcd34d"],
  };

  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "net.auth" },
  });

  const num = (v) => (v === null || v === undefined ? null : Number(v));
  const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const monthLabel = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short" }) + " " + iso.slice(2, 4);
  const must = ({ data, error }) => { if (error) throw error; return data; };

  function depositStats(d, current) {
    if (!d) return null;
    const total = num(d.total_deposits_myr);
    if (!total) return null;
    const gain = current - total;
    return {
      total_deposits_myr: total, total_withdrawals_myr: num(d.total_withdrawals_myr),
      gain_myr: gain, return_pct: (gain / total) * 100, verified: !!d.verified, source: d.source,
      first_deposit: d.first_deposit, deposit_count: (d.transfers || []).length || null,
      usd_cost_basis: num(d.usd_cost_basis), avg_rate_myr_usd: num(d.avg_rate_myr_usd),
    };
  }

  function assemble({ accounts, history, positions, fx, deposits, projection }) {
    const dates = history.map((h) => h.date);
    const depBy = Object.fromEntries(deposits.map((d) => [d.account_id, d]));

    const out = accounts.map((a) => {
      const broker = a.source.startsWith("broker:");
      const current = num(a.current_balance) || 0;
      return {
        id: a.id, name: a.name, type: a.type, kind: a.kind || a.type, source: a.source,
        snapshots: history.map((h) => num(h.balances[a.id]) || 0),
        tracked: history.map((h) => a.id in h.balances),
        current_balance: current, as_of: a.as_of,
        institution: broker ? a.account_label || "" : a.kind || "", last4: "",
        connected: broker ? "Synced from your Mac" : "Manual entry",
        sync: broker ? (a.synced_at ? `Live · ${a.as_of}` : "Waiting for your Mac") : `Manual · updated ${a.as_of || "—"}`,
        apiBased: broker,
        invested: broker ? num(a.invested) : null,
        cash: broker ? num(a.cash) : null,
        pnl: broker ? num(a.pnl) : null,
        sync_error: a.sync_error, synced_at: a.synced_at,
        positions: positions.filter((p) => p.account_id === a.id).map((p) => ({
          sym: p.symbol, name: p.description || p.symbol, units: num(p.qty) || 0, currency: p.currency,
          value: num(p.value_myr) || 0, pnl: num(p.pnl_myr), price: num(p.price), cost: num(p.cost_price),
          ticker: p.yahoo_ticker,
          logo: STOCK_LOGOS.has(p.yahoo_ticker || p.symbol) ? `logos/stocks/${p.yahoo_ticker || p.symbol}.png` : null,
        })),
        deposits: depositStats(depBy[a.id], current),
        logo: LOGOS.has(a.id) ? `logos/${a.id}.png` : null,
      };
    });

    // Live "Now" point only when balances moved since the last saved snapshot.
    const differs = !dates.length || out.some((a) => Math.abs((a.snapshots[a.snapshots.length - 1] || 0) - a.current_balance) > 0.5);
    const labels = dates.map(monthLabel);
    if (differs) {
      dates.push(isoLocal(new Date()));
      labels.push("Now");
      for (const a of out) {
        const was = a.tracked.length ? a.tracked[a.tracked.length - 1] : false;
        a.snapshots.push(a.current_balance);
        a.tracked.push(was || !!a.current_balance);
      }
    }

    for (const [type, ramp] of Object.entries(TYPE_RAMP)) {
      out.filter((a) => a.type === type).sort((x, y) => y.current_balance - x.current_balance)
        .forEach((a, i) => { a.color = ramp[Math.min(i, ramp.length - 1)]; });
    }

    const nameOf = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
    const fxPairs = fx.filter((f) => f.currency !== "MYR");
    const brokers = accounts.filter((a) => a.source.startsWith("broker:"));
    const synced = brokers.map((a) => a.synced_at).filter(Boolean).sort();

    return {
      currency: "MYR",
      fx: fxPairs.map((f) => `1 ${f.currency} = ${Number(f.rate_to_myr).toFixed(4)} MYR`).join(" · ") || "All amounts in MYR",
      months: labels,
      dates,
      live_point: differs,
      accounts: out,
      totals: dates.map((_, i) => out.reduce((s, a) => s + (a.snapshots[i] || 0), 0)),
      snapshots: [...history].reverse().map((h) => ({
        date: h.date, label: h.label, reasons: h.reasons || [], updated_at: h.updated_at,
        accounts: Object.fromEntries(Object.entries(h.balances).map(([k, v]) => [nameOf[k] || k, Number(v)])),
      })),
      broker_errors: Object.fromEntries(brokers.filter((a) => a.sync_error).map((a) => [a.source.split(":")[1], a.sync_error])),
      broker_as_of: synced.length ? synced[synced.length - 1].slice(0, 10) : null,
      projection: projection ? { assumptions: projection.assumptions, plan: projection.plan, updated_at: projection.updated_at } : null,
    };
  }

  const noteSubs = new Set();   // screens showing notes re-render when they change
  function publish(snap, offlineAt) {
    window.FINANCE_DATA = snap.state;
    window.QUOTES = snap.quotes || {};
    window.QUOTES_AT = snap.quotesAt ? new Date(snap.quotesAt) : null;
    window.PRICES = snap.prices || {};
    window.AGENT = snap.agent || null;
    window.OFFLINE_AT = offlineAt || null;
    window.NOTES = snap.notes || [];
    window.NOTES_STATE = snap.notesState || "ready";   // "ready" | "missing" (run supabase/notes.sql) | "error"
    noteSubs.forEach((fn) => fn(window.NOTES));
  }

  // Notes (the money journal) change without a full reload.
  function setNotes(next) {
    window.NOTES = next;
    try {
      const snap = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (snap) { snap.notes = next; snap.notesState = window.NOTES_STATE; localStorage.setItem(CACHE_KEY, JSON.stringify(snap)); }
    } catch {}
    noteSubs.forEach((fn) => fn(next));
  }
  const missingTable = (e) => e && (e.code === "PGRST205" || e.code === "42P01" || /notes/.test(e.message || "") && /schema cache|does not exist/.test(e.message || ""));

  const Net = {
    sb,

    async session() {
      try { return (await sb.auth.getSession()).data.session; } catch { return null; }
    },
    async user() { const s = await this.session(); return s && s.user; },
    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    async signOut() {
      try { localStorage.removeItem(CACHE_KEY); } catch {}
      await sb.auth.signOut();
      location.reload();
    },

    // Fetch + assemble. Throws on network/auth failure (caller may fall back to cache).
    async load() {
      const since = new Date(); since.setDate(since.getDate() - 40);
      const [accounts, history, positions, fx, deposits, projection, quotes, agent, prices, notesRes] = await Promise.all([
        sb.from("accounts").select("*").order("sort_order").then(must),
        sb.rpc("get_history").then(must),
        sb.from("positions").select("*").then(must),
        sb.from("fx_rates").select("*").then(must),
        sb.from("deposits").select("*").then(must),
        sb.from("projection").select("*").maybeSingle().then(must),
        sb.from("quotes").select("*").then(must),
        sb.from("agent_status").select("*").maybeSingle().then(must),
        sb.rpc("get_prices", { p_since: isoLocal(since) }).then(must),
        // Tolerant: the app keeps working before supabase/notes.sql has been run.
        sb.from("notes").select("*").order("created_at", { ascending: false }).limit(2000),
      ]);
      const snap = {
        at: new Date().toISOString(),
        state: assemble({ accounts, history: history || [], positions, fx, deposits, projection }),
        quotes: Object.fromEntries(quotes.map((q) => [q.ticker, {
          price: num(q.price), prev_close: num(q.prev_close), change_pct: num(q.change_pct), currency: q.currency, fetched_at: q.fetched_at,
        }])),
        quotesAt: quotes.map((q) => q.fetched_at).sort().pop() || null,
        prices: prices || {},
        agent,
        notes: notesRes.error ? (window.NOTES || []) : notesRes.data,
        notesState: !notesRes.error ? "ready" : missingTable(notesRes.error) ? "missing" : "error",
      };
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(snap)); } catch {}
      publish(snap, null);
      return snap.state;
    },

    // Last good state from this device. stale: shown while a fresh load runs
    // (no offline banner); otherwise it's the offline fallback.
    loadCached({ stale = false } = {}) {
      try {
        const snap = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
        if (!snap || !snap.state) return null;
        publish(snap, stale ? null : snap.at);
        window.STALE_AT = stale ? snap.at : null;
        return snap.state;
      } catch { return null; }
    },

    async reload() {
      try { return await this.load(); }
      catch (e) { if (!window.FINANCE_DATA) this.loadCached(); throw e; }
    },

    async updateBalance(accountId, amount, asOf) {
      must(await sb.rpc("update_balance", { p_account: accountId, p_amount: Number(amount), p_as_of: asOf || null }));
      return this.load();
    },

    async saveSnapshot() {
      must(await sb.rpc("record_snapshot", { p_reason: "manual" }));
      return this.load();
    },

    // Ask the Mac agent to refresh. Resolves when it finishes, or reports that
    // the request is queued because the Mac hasn't checked in recently.
    async requestSync(kind = "sync", { timeoutMs = 120000, onUpdate } = {}) {
      const row = must(await sb.from("sync_requests").insert({ kind }).select().single());
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        await new Promise((r) => setTimeout(r, 2500));
        const cur = must(await sb.from("sync_requests").select("*").eq("id", row.id).single());
        if (onUpdate) onUpdate(cur);
        if (cur.status === "done" || cur.status === "failed") {
          await this.load();
          return cur;
        }
        if (cur.status === "pending" && Date.now() - started > 15000) {
          const agent = must(await sb.from("agent_status").select("*").maybeSingle());
          const seen = agent && agent.last_seen ? Date.now() - new Date(agent.last_seen).getTime() : Infinity;
          if (seen > 3 * 60 * 1000) return { ...cur, status: "queued", agent };
        }
      }
      return { ...row, status: "timeout" };
    },

    // Same rules as the old server: first save (or rebaseline) pins the plan
    // to today's balances; otherwise the existing plan baseline is kept.
    async saveProjection(assumptions, rebaseline) {
      const user = await this.user();
      const D = window.FINANCE_DATA;
      const existing = D.projection && D.projection.plan;
      let plan = existing ? { ...existing, assumptions: existing.assumptions } : null;
      if (rebaseline || !existing || !existing.base_date) {
        const byType = {};
        for (const a of D.accounts) byType[a.type] = (byType[a.type] || 0) + (a.current_balance || 0);
        plan = {
          base_date: D.dates[D.dates.length - 1],
          base_by_type: byType,
          base_accounts: D.accounts.filter((a) => Math.abs(a.current_balance || 0) >= 1).map((a) => a.name),
          base_total: Object.values(byType).reduce((s, v) => s + v, 0),
          assumptions,
        };
      }
      must(await sb.from("projection").upsert({ owner: user.id, assumptions, plan, updated_at: new Date().toISOString() }));
      return this.load();
    },

    // ---- Notes ----
    onNotes(fn) { noteSubs.add(fn); return () => noteSubs.delete(fn); },
    async addNote({ body, account_ids = [], happened_on = null }) {
      const row = must(await sb.from("notes").insert({ body, account_ids, happened_on }).select().single());
      window.NOTES_STATE = "ready";
      setNotes([row, ...(window.NOTES || [])]);
      return row;
    },
    async updateNote(id, patch) {
      const row = must(await sb.from("notes").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select().single());
      setNotes((window.NOTES || []).map((n) => (n.id === id ? row : n)));
      return row;
    },
    async restoreNote(note) {   // undo a delete: same id and timestamps
      const { id, body, account_ids, happened_on, created_at, updated_at } = note;
      const row = must(await sb.from("notes").insert({ id, body, account_ids, happened_on, created_at, updated_at }).select().single());
      setNotes([row, ...(window.NOTES || [])].sort((x, y) => (x.created_at < y.created_at ? 1 : -1)));
      return row;
    },
    async deleteNote(id) {
      must(await sb.from("notes").delete().eq("id", id));
      setNotes((window.NOTES || []).filter((n) => n.id !== id));
    },

    async priceHistory(ticker, sinceIso) {
      const data = must(await sb.rpc("get_prices", { p_since: sinceIso }));
      return (data && data[ticker]) || [];
    },
  };

  window.Net = Net;
})();
