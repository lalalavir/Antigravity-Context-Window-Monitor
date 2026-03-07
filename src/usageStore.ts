// ─── Usage History Store ──────────────────────────────────────────────────────
// Incrementally accumulates per-conversation token usage snapshots during
// normal polling, persisted to globalState for cross-session survival.
// The Webview reads from memory — zero RPC overhead on open.

import * as vscode from 'vscode';
import { ContextUsage, CheckpointModelUsage } from './tracker';
import { calculateSegmentedCost } from './cost';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConversationSnapshot {
    cascadeId: string;
    title: string;
    model: string;
    modelDisplayName: string;
    inputTokens: number;
    outputTokens: number;
    /** Equivalent API cost in USD (segmented across models). */
    cost: number;
    /** Per-model segment breakdown for multi-model conversations. */
    checkpointUsages: CheckpointModelUsage[];
    /** ISO timestamp of last conversation activity — used for date grouping. */
    lastModifiedTime: string;
    stepCount: number;
    /** Date.now() when this snapshot was last written — used for dedup. */
    updatedAt: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'usageHistory';
/** Minimum interval between globalState writes (ms). */
const PERSIST_THROTTLE_MS = 30_000;

// ─── UsageStore ───────────────────────────────────────────────────────────────

export class UsageStore {
    private snapshots: Map<string, ConversationSnapshot>;
    private globalState: vscode.Memento;
    private dirty = false;
    private lastPersistTime = 0;

    constructor(globalState: vscode.Memento) {
        this.globalState = globalState;
        this.snapshots = new Map();
        this.load();
    }

    // ── Load from globalState ─────────────────────────────────────────────

    private load(): void {
        const raw = this.globalState.get<ConversationSnapshot[]>(STORAGE_KEY, []);
        for (const snap of raw) {
            this.snapshots.set(snap.cascadeId, snap);
        }
    }

    // ── Record / Update ───────────────────────────────────────────────────

    /**
     * Record or update a conversation snapshot from polling data.
     * Computes segmented cost from checkpointUsages automatically.
     */
    record(usage: ContextUsage): void {
        // Compute cost from checkpoint segments
        const allUsages = [
            ...usage.checkpointUsages,
            ...usage.postCheckpointModelDeltas,
        ];
        const { total: cost } = calculateSegmentedCost(allUsages);

        // Compute total input/output from checkpoint data
        let inputTokens = 0;
        let outputTokens = 0;
        for (const cp of allUsages) {
            inputTokens += cp.inputTokens;
            outputTokens += cp.outputTokens;
        }

        const snapshot: ConversationSnapshot = {
            cascadeId: usage.cascadeId,
            title: usage.title,
            model: usage.model,
            modelDisplayName: usage.modelDisplayName,
            inputTokens,
            outputTokens,
            cost,
            checkpointUsages: allUsages,
            lastModifiedTime: usage.lastModifiedTime,
            stepCount: usage.stepCount,
            updatedAt: Date.now(),
        };

        this.snapshots.set(usage.cascadeId, snapshot);
        this.dirty = true;
    }

    // ── Query ─────────────────────────────────────────────────────────────

    /** Return all snapshots (no copy — read-only). */
    getAll(): ConversationSnapshot[] {
        return Array.from(this.snapshots.values());
    }

    /** Return snapshots whose lastModifiedTime falls within [start, end). */
    getByDateRange(start: Date, end: Date): ConversationSnapshot[] {
        const startMs = start.getTime();
        const endMs = end.getTime();
        return this.getAll().filter(s => {
            const t = new Date(s.lastModifiedTime).getTime();
            return t >= startMs && t < endMs;
        });
    }

    // ── Persist ───────────────────────────────────────────────────────────

    /**
     * Persist to globalState if dirty.
     * Throttled: skips if called within PERSIST_THROTTLE_MS of last write.
     * Call with force=true to bypass throttle (e.g. on deactivate).
     */
    persist(force = false): void {
        if (!this.dirty) { return; }
        const now = Date.now();
        if (!force && (now - this.lastPersistTime) < PERSIST_THROTTLE_MS) {
            return;
        }
        const data = this.getAll();
        this.globalState.update(STORAGE_KEY, data);
        this.lastPersistTime = now;
        this.dirty = false;
    }
}
