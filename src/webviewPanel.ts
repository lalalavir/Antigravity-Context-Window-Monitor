// ─── Usage Report Webview Panel ───────────────────────────────────────────────
// Singleton Webview that displays a rolling 7-day usage statistics table.
// Data comes from UsageStore (in-memory) — no RPC calls on open.

import * as vscode from 'vscode';
import { UsageStore, ConversationSnapshot } from './usageStore';
import { formatCost, getModelPricing } from './cost';

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEW_TYPE = 'antigravityUsageReport';
const WINDOW_DAYS = 7;

// ─── Panel Singleton ──────────────────────────────────────────────────────────

export class UsageReportPanel {
  private static instance: UsageReportPanel | undefined;
  private panel: vscode.WebviewPanel;
  private store: UsageStore;
  /** Current window start date (beginning of day, local time). */
  private windowStart: Date;

  private constructor(panel: vscode.WebviewPanel, store: UsageStore) {
    this.panel = panel;
    this.store = store;
    // Default: 7 days ago at midnight
    this.windowStart = startOfDay(addDays(new Date(), -(WINDOW_DAYS - 1)));

    this.panel.webview.onDidReceiveMessage(msg => {
      if (msg.command === 'prev') {
        this.windowStart = addDays(this.windowStart, -WINDOW_DAYS);
        this.refresh();
      } else if (msg.command === 'next') {
        this.windowStart = addDays(this.windowStart, WINDOW_DAYS);
        this.refresh();
      }
    });

    this.panel.onDidDispose(() => {
      UsageReportPanel.instance = undefined;
    });

    this.refresh();
  }

  static createOrShow(context: vscode.ExtensionContext, store: UsageStore): void {
    if (UsageReportPanel.instance) {
      UsageReportPanel.instance.panel.reveal();
      UsageReportPanel.instance.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      '📊 Usage Report / 用量报告',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    UsageReportPanel.instance = new UsageReportPanel(panel, store);
    context.subscriptions.push(panel);
  }

  /** Called externally after poll updates to live-refresh an open panel. */
  static refreshIfVisible(): void {
    if (UsageReportPanel.instance?.panel.visible) {
      UsageReportPanel.instance.refresh();
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  private refresh(): void {
    const windowEnd = addDays(this.windowStart, WINDOW_DAYS);
    const snapshots = this.store.getByDateRange(this.windowStart, windowEnd);
    this.panel.webview.html = this.buildHtml(snapshots, this.windowStart, windowEnd);
  }

  private buildHtml(snapshots: ConversationSnapshot[], start: Date, end: Date): string {
    // ── Aggregate by day ──────────────────────────────────────────────
    const dailyMap = new Map<string, { convos: number; input: number; output: number; cost: number }>();
    const modelTotals = new Map<string, { displayName: string; input: number; output: number; cost: number }>();

    let totalInput = 0, totalOutput = 0, totalCost = 0;

    for (const snap of snapshots) {
      // Day key: YYYY-MM-DD in LOCAL timezone
      const dayKey = snap.lastModifiedTime
        ? fmtDateLocal(new Date(snap.lastModifiedTime))
        : 'unknown';

      const day = dailyMap.get(dayKey) || { convos: 0, input: 0, output: 0, cost: 0 };
      day.convos++;
      day.input += snap.inputTokens;
      day.output += snap.outputTokens;
      day.cost += snap.cost;
      dailyMap.set(dayKey, day);

      totalInput += snap.inputTokens;
      totalOutput += snap.outputTokens;
      totalCost += snap.cost;

      // Per-model aggregation
      for (const cp of snap.checkpointUsages) {
        const key = cp.model || 'unknown';
        const pricing = getModelPricing(key);
        const cpCost = (cp.inputTokens * pricing.inputPerMillion +
          cp.outputTokens * pricing.outputPerMillion) / 1_000_000;
        const m = modelTotals.get(key) || { displayName: pricing.displayName, input: 0, output: 0, cost: 0 };
        m.input += cp.inputTokens;
        m.output += cp.outputTokens;
        m.cost += cpCost;
        modelTotals.set(key, m);
      }
    }

    // Sort days descending
    const sortedDays = Array.from(dailyMap.entries())
      .sort((a, b) => b[0].localeCompare(a[0]));

    // Sort models by cost descending
    const sortedModels = Array.from(modelTotals.entries())
      .sort((a, b) => b[1].cost - a[1].cost);

    // ── Format date range (local timezone) ──────────────────────────
    const rangeLabel = `${fmtDateLocal(start)} ~ ${fmtDateLocal(addDays(end, -1))}`;

    // ── Build HTML ────────────────────────────────────────────────────
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px 24px;
    margin: 0;
  }
  h2 { margin: 0 0 16px; font-weight: 600; }

  /* ── Summary Cards ── */
  .cards {
    display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap;
  }
  .card {
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border, #444));
    border-radius: 6px;
    padding: 12px 18px;
    min-width: 140px;
    flex: 1;
  }
  .card .label {
    font-size: 11px;
    text-transform: uppercase;
    opacity: 0.65;
    margin-bottom: 4px;
  }
  .card .value {
    font-size: 22px;
    font-weight: 700;
    color: var(--vscode-textLink-foreground);
  }
  .card .sub {
    font-size: 11px;
    opacity: 0.55;
    margin-top: 2px;
  }

  /* ── Tables ── */
  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 20px;
    font-size: 13px;
  }
  th {
    text-align: left;
    padding: 8px 10px;
    background: var(--vscode-editorGroupHeader-tabsBackground);
    border-bottom: 2px solid var(--vscode-editorWidget-border, #555);
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    opacity: 0.8;
  }
  td {
    padding: 7px 10px;
    border-bottom: 1px solid var(--vscode-editorWidget-border, #333);
  }
  tr:nth-child(even) td {
    background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.03));
  }
  tr:hover td {
    background: var(--vscode-list-activeSelectionBackground, rgba(255,255,255,0.08));
  }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .total-row td {
    font-weight: 700;
    border-top: 2px solid var(--vscode-editorWidget-border, #555);
    border-bottom: none;
  }

  /* ── Navigation ── */
  .nav {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    margin-bottom: 20px;
  }
  .nav button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    padding: 6px 14px;
    cursor: pointer;
    font-size: 13px;
  }
  .nav button:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .nav .range {
    font-size: 14px;
    font-weight: 600;
    opacity: 0.85;
  }

  .section-title {
    font-size: 14px;
    font-weight: 600;
    margin: 20px 0 8px;
    opacity: 0.8;
  }
  .empty {
    text-align: center;
    padding: 40px;
    opacity: 0.5;
    font-size: 14px;
  }
</style>
</head>
<body>
  <h2>📊 Token Usage Report / 用量报告</h2>

  <!-- Navigation -->
  <div class="nav">
    <button onclick="post('prev')">◀ 上一周</button>
    <span class="range">${rangeLabel}</span>
    <button onclick="post('next')">下一周 ▶</button>
  </div>

  <!-- Summary Cards -->
  <div class="cards">
    <div class="card">
      <div class="label">Total Cost / 总费用</div>
      <div class="value">${formatCost(totalCost)}</div>
      <div class="sub">equivalent API cost</div>
    </div>
    <div class="card">
      <div class="label">Conversations / 对话</div>
      <div class="value">${snapshots.length}</div>
      <div class="sub">in this period</div>
    </div>
    <div class="card">
      <div class="label">Input Tokens</div>
      <div class="value">${fmtTokens(totalInput)}</div>
      <div class="sub">${totalInput.toLocaleString()} total</div>
    </div>
    <div class="card">
      <div class="label">Output Tokens</div>
      <div class="value">${fmtTokens(totalOutput)}</div>
      <div class="sub">${totalOutput.toLocaleString()} total</div>
    </div>
  </div>

  <!-- Daily Breakdown -->
  <div class="section-title">📅 Daily Breakdown / 每日明细</div>
  ${sortedDays.length === 0
        ? '<div class="empty">No data in this period / 该时段无数据</div>'
        : `<table>
    <tr>
      <th>Date / 日期</th>
      <th class="num">Convos / 对话</th>
      <th class="num">Input Tokens</th>
      <th class="num">Output Tokens</th>
      <th class="num">Cost / 费用</th>
    </tr>
    ${sortedDays.map(([day, d]) => `<tr>
      <td>${day}</td>
      <td class="num">${d.convos}</td>
      <td class="num">${d.input.toLocaleString()}</td>
      <td class="num">${d.output.toLocaleString()}</td>
      <td class="num">${formatCost(d.cost)}</td>
    </tr>`).join('')}
    <tr class="total-row">
      <td>Total / 合计</td>
      <td class="num">${snapshots.length}</td>
      <td class="num">${totalInput.toLocaleString()}</td>
      <td class="num">${totalOutput.toLocaleString()}</td>
      <td class="num">${formatCost(totalCost)}</td>
    </tr>
  </table>`}

  <!-- Model Breakdown -->
  ${sortedModels.length > 0 ? `
  <div class="section-title">🤖 By Model / 按模型</div>
  <table>
    <tr>
      <th>Model / 模型</th>
      <th class="num">Input Tokens</th>
      <th class="num">Output Tokens</th>
      <th class="num">Cost / 费用</th>
    </tr>
    ${sortedModels.map(([, m]) => `<tr>
      <td>${m.displayName}</td>
      <td class="num">${m.input.toLocaleString()}</td>
      <td class="num">${m.output.toLocaleString()}</td>
      <td class="num">${formatCost(m.cost)}</td>
    </tr>`).join('')}
  </table>` : ''}

  <script>
    const vscode = acquireVsCodeApi();
    function post(cmd) { vscode.postMessage({ command: cmd }); }
  </script>
</body>
</html>`;
  }
}

// ─── Date Helpers ─────────────────────────────────────────────────────────────

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Format a Date as YYYY-MM-DD in local timezone (not UTC). */
function fmtDateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}k`; }
  return n.toString();
}
