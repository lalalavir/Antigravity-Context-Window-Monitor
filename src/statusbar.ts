import * as vscode from 'vscode';
import { ContextUsage } from './tracker';
import { calculateCost, formatCost, costTooltipLines, calculateSegmentedCost, segmentedCostTooltipLines } from './cost';

// ─── Token Formatting ─────────────────────────────────────────────────────────

/**
 * Format a token count for display (e.g. 45231 → "45.2k", 1500000 → "1500k").
 */
export function formatTokenCount(count: number): string {
    const safeCount = Math.max(0, count);
    // CR-m1: M suffix for values >= 1M for better readability
    if (safeCount >= 1_000_000) {
        return `${(safeCount / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    }
    if (safeCount >= 1_000) {
        return `${(safeCount / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
    }
    return safeCount.toString();
}

/**
 * Format a context limit for display (e.g. 2000000 → "2000k").
 */
export function formatContextLimit(limit: number): string {
    // CR2-Fix8: Clamp negative values to 0 to prevent nonsensical display
    const safeLimit = Math.max(0, limit);
    // CR-M7: M suffix for values >= 1M, consistent with formatTokenCount
    if (safeLimit >= 1_000_000) {
        return `${(safeLimit / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    }
    if (safeLimit >= 1_000) {
        const val = safeLimit / 1_000;
        return val === Math.floor(val) ? `${val}k` : `${val.toFixed(1)}k`;
    }
    return safeLimit.toString();
}

/**
 * m5: Escape Markdown special characters in dynamic content to prevent
 * broken rendering in VS Code tooltip MarkdownStrings.
 */
function escapeMarkdown(text: string): string {
    // CR-m1: Also escape < and > to prevent MarkdownString HTML interpretation
    return text.replace(/([|*_~`\[\]\\#<>])/g, '\\$1');
}

export interface CompressionStats {
    source: 'context' | 'checkpoint';
    dropTokens: number;
    dropPercent: number;
}

/**
 * Calculate compression amount for UI display.
 *
 * Priority:
 * 1) Cross-poll context drop (previousContextUsed -> contextUsed), if available.
 * 2) Checkpoint input drop (checkpointCompressionDrop), if available.
 */
export function calculateCompressionStats(usage: ContextUsage): CompressionStats | null {
    if (!usage.compressionDetected) { return null; }

    if (usage.previousContextUsed !== undefined && usage.previousContextUsed > usage.contextUsed) {
        const dropTokens = usage.previousContextUsed - usage.contextUsed;
        const dropPercent = usage.previousContextUsed > 0
            ? (dropTokens / usage.previousContextUsed) * 100
            : 0;
        return {
            source: 'context',
            dropTokens,
            dropPercent,
        };
    }

    if (usage.checkpointCompressionDrop > 0) {
        const currentInput = usage.lastModelUsage?.inputTokens;
        const previousInput = currentInput !== undefined
            ? currentInput + usage.checkpointCompressionDrop
            : 0;
        const dropPercent = previousInput > 0
            ? (usage.checkpointCompressionDrop / previousInput) * 100
            : 0;
        return {
            source: 'checkpoint',
            dropTokens: usage.checkpointCompressionDrop,
            dropPercent,
        };
    }

    return null;
}

// ─── Status Bar Colors ────────────────────────────────────────────────────────

type StatusBarSeverity = 'ok' | 'warning' | 'error' | 'critical';

function getSeverity(usagePercent: number): StatusBarSeverity {
    if (usagePercent >= 95) { return 'critical'; }
    if (usagePercent >= 80) { return 'error'; }
    if (usagePercent >= 50) { return 'warning'; }
    return 'ok';
}

function getSeverityColor(severity: StatusBarSeverity): vscode.ThemeColor | undefined {
    switch (severity) {
        case 'critical': return new vscode.ThemeColor('statusBarItem.errorBackground');
        case 'error': return new vscode.ThemeColor('statusBarItem.errorBackground');
        case 'warning': return new vscode.ThemeColor('statusBarItem.warningBackground');
        default: return undefined;
    }
}

function getSeverityIcon(severity: StatusBarSeverity): string {
    switch (severity) {
        case 'critical': return '$(zap)';
        case 'error': return '$(warning)';
        case 'warning': return '$(info)';
        default: return '$(pulse)';
    }
}

// ─── Status Bar Manager ───────────────────────────────────────────────────────

export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'antigravity-context-monitor.showUsageReport';
        this.statusBarItem.name = 'Context Window Monitor / 上下文窗口监控';
        this.showInitializing();
        this.statusBarItem.show();
    }

    /**
     * Show initializing state.
     */
    showInitializing(): void {
        this.statusBarItem.text = '$(sync~spin) Context...';
        this.statusBarItem.tooltip = 'Antigravity Context Monitor: Initializing / 初始化中...';
        this.statusBarItem.backgroundColor = undefined;
    }

    /**
     * Show error/disconnected state.
     */
    showDisconnected(message: string): void {
        this.statusBarItem.text = '$(debug-disconnect) Context: N/A';
        this.statusBarItem.tooltip = `Antigravity Context Monitor: ${message}`;
        this.statusBarItem.backgroundColor = undefined;
    }

    /**
     * Show no active conversation state.
     */
    showNoConversation(limitStr: string = '1000k'): void {
        this.statusBarItem.text = `$(comment-discussion) 0k/${limitStr}, 0.0%`;
        const md = new vscode.MarkdownString(
            `Antigravity Context Monitor: No active conversation / 无活跃会话  \nClick to view details / 点击查看详情`,
            false
        );
        md.supportThemeIcons = true;
        this.statusBarItem.tooltip = md;
        this.statusBarItem.backgroundColor = undefined;
    }

    /**
     * Show idle state (conversations exist but none is actively running).
     */
    showIdle(limitStr: string = '1000k'): void {
        this.statusBarItem.text = `$(clock) 0k/${limitStr}, 0.0%`;
        const md = new vscode.MarkdownString(
            `Antigravity Context Monitor: Idle / 空闲  \nNew or ended conversation / 新建对话或已结束  \nClick to view details / 点击查看详情`,
            false
        );
        md.supportThemeIcons = true;
        this.statusBarItem.tooltip = md;
        this.statusBarItem.backgroundColor = undefined;
    }

    /**
     * Update the status bar with current context usage data.
     *
     * Display strategy for >100% (context compression):
     * - Shows actual usage value but caps the percentage display with a
     *   compression indicator, e.g. "205k/200k, ~100% 🗜" instead of ">100%"
     * - This reflects that the model is auto-compressing and the actual
     *   inputTokens will drop on the next checkpoint after compression
     */
    update(usage: ContextUsage): void {
        const usedStr = formatTokenCount(usage.contextUsed);
        const limitStr = formatContextLimit(usage.contextLimit);

        // Handle compression: if usage exceeds limit, show with compression indicator
        const isCompressing = usage.usagePercent > 100;
        const displayPercent = isCompressing
            ? '~100'
            : usage.usagePercent.toFixed(1).replace(/\.0$/, '');
        const compressIcon = isCompressing ? ' 🗜' : '';

        const severity = getSeverity(usage.usagePercent);
        const icon = getSeverityIcon(severity);

        // CR2-Fix2: Show gaps warning in main status bar text (not just tooltip)
        // so users can see data incompleteness without hovering.
        const gapsIndicator = usage.hasGaps ? ' ⚠️' : '';

        // Calculate equivalent API cost — use segmented cost when checkpoint data exists
        const hasCheckpoints = usage.checkpointUsages && usage.checkpointUsages.length > 0;
        let cost: number;
        let costStr: string;
        const inputTokens = usage.lastModelUsage?.inputTokens || usage.contextUsed;
        const outputTokens = usage.totalOutputTokens || 0;

        // Build augmented checkpoint array: append per-model deltas computed by
        // processSteps (overhead since last checkpoint, split by model).
        // This data persists regardless of the user's current model selection,
        // so switching models in the UI won't hide previously accumulated costs.
        let augmentedCheckpoints = usage.checkpointUsages || [];
        if (usage.postCheckpointModelDeltas && usage.postCheckpointModelDeltas.length > 0) {
            augmentedCheckpoints = [...usage.checkpointUsages, ...usage.postCheckpointModelDeltas];
        }

        if (hasCheckpoints) {
            const segmented = calculateSegmentedCost(augmentedCheckpoints);
            cost = segmented.total;
            costStr = formatCost(cost);
        } else {
            cost = calculateCost(usage.model, inputTokens, outputTokens);
            costStr = formatCost(cost);
        }

        this.statusBarItem.text = `${icon} ${usedStr}/${limitStr}, ${displayPercent}%${compressIcon}${gapsIndicator} | ${costStr}`;
        this.statusBarItem.backgroundColor = getSeverityColor(severity);

        // Build detailed tooltip (m5: escape dynamic content for Markdown safety)
        const dataSourceLabel = usage.isEstimated
            ? '⚠️ Estimated / 估算值'
            : '✅ Precise (from checkpoint) / 精确值 (来自 checkpoint)';
        const remaining = Math.max(0, usage.contextLimit - usage.contextUsed);
        const compressionStats = calculateCompressionStats(usage);
        const safeTitle = escapeMarkdown(usage.title || usage.cascadeId.substring(0, 8));
        const safeModelName = escapeMarkdown(usage.modelDisplayName);

        const lines = [
            `📊 Context Window Usage / 上下文窗口使用情况`,
            `——————————`,
            `🤖 Model / 模型: ${safeModelName}`,
            `📝 Session / 会话: ${safeTitle}`,
            `——————————`,
            `📥 Total Context Used / 总上下文占用 (input+output):`,
            `     ${usage.contextUsed.toLocaleString()} tokens`,
            `📤 Model Output / 模型输出: ${usage.totalOutputTokens.toLocaleString()} tokens`,
            `🔧 Tool Results / 工具结果: ${usage.totalToolCallOutputTokens.toLocaleString()} tokens`,
            `📦 Limit / 窗口上限: ${usage.contextLimit.toLocaleString()} tokens`,
            `📊 Usage / 使用率: ${usage.usagePercent.toFixed(1)}%`,
        ];

        if (isCompressing) {
            lines.push(`🗜 Compressing / 压缩中: Model is auto-compressing context`);
            lines.push(`💡 Context will shrink after compression completes.`);
            lines.push(`   模型正自动压缩上下文，压缩完成后数值将下降。`);
        } else if (usage.compressionDetected) {
            // C3: Show compression completion info
            lines.push(`🗜 Compressed / 已压缩: Context was auto-compressed`);
            if (usage.previousContextUsed !== undefined) {
                lines.push(`   Before / 压缩前: ${usage.previousContextUsed.toLocaleString()} tokens`);
                lines.push(`   After / 压缩后: ${usage.contextUsed.toLocaleString()} tokens`);
            }
            if (compressionStats) {
                const sourceLabel = compressionStats.source === 'context'
                    ? 'Context Drop / 上下文压缩量'
                    : 'Checkpoint Input Drop / 检查点输入压缩量';
                lines.push(
                    `   ${sourceLabel}: ${compressionStats.dropTokens.toLocaleString()} tokens ` +
                    `(${compressionStats.dropPercent.toFixed(1)}%)`
                );
            }
            lines.push(`   上下文已被模型自动压缩。`);
        } else {
            lines.push(`📐 Remaining / 剩余: ${remaining.toLocaleString()} tokens`);
        }

        // CR-C3: Warn if step data may be incomplete
        if (usage.hasGaps) {
            lines.push(`⚠️ Data may be incomplete / 数据可能不完整 (some step batches failed to load)`);
        }

        lines.push(`🔢 Steps / 步骤数: ${usage.stepCount}`);

        // Show image generation info if detected
        if (usage.imageGenStepCount > 0) {
            lines.push(`📷 Image Gen / 图片生成: ${usage.imageGenStepCount} step(s) detected / 检测到 ${usage.imageGenStepCount} 个图片生成步骤`);
        }

        // Show estimation delta if applicable
        if (usage.estimatedDeltaSinceCheckpoint > 0 && usage.lastModelUsage) {
            lines.push(`📏 Est. delta / 估算增量: +${usage.estimatedDeltaSinceCheckpoint.toLocaleString()} tokens (since last checkpoint / 自上次检查点)`);
        }

        // Cost section — use segmented breakdown for multi-model, single-model otherwise
        lines.push(`——————————`);
        if (hasCheckpoints) {
            const segmented = calculateSegmentedCost(augmentedCheckpoints);
            const segLines = segmentedCostTooltipLines(segmented.segments, segmented.total);
            for (const cl of segLines) { lines.push(cl); }
        } else {
            const singleCostLines = costTooltipLines(usage.model, inputTokens, outputTokens, cost);
            for (const cl of singleCostLines) { lines.push(cl); }
        }

        lines.push(`——————————`);

        // Show checkpoint model usage details if available
        if (usage.lastModelUsage) {
            lines.push(`📎 Last Checkpoint / 最近 checkpoint:`);
            lines.push(`  Input / 输入: ${usage.lastModelUsage.inputTokens.toLocaleString()}`);
            lines.push(`  Output / 输出: ${usage.lastModelUsage.outputTokens.toLocaleString()}`);
            if (usage.lastModelUsage.cacheReadTokens > 0) {
                lines.push(`  Cache / 缓存: ${usage.lastModelUsage.cacheReadTokens.toLocaleString()}`);
            }
        }

        lines.push(`——————————`);
        lines.push(`${dataSourceLabel}`);
        lines.push(`Click to view details / 点击查看详情`);

        const md = new vscode.MarkdownString(
            lines.join('  \n'),
            false
        );
        md.supportThemeIcons = true;
        this.statusBarItem.tooltip = md;
    }

    /**
     * Show detailed info in a QuickPick panel.
     */
    async showDetailsPanel(
        currentUsage: ContextUsage | null,
        allTrajectoryUsages: ContextUsage[]
    ): Promise<void> {
        if (!currentUsage && allTrajectoryUsages.length === 0) {
            vscode.window.showInformationMessage('No context window data available / 没有可用的上下文使用数据');
            return;
        }

        const items: vscode.QuickPickItem[] = [];

        // Current conversation header
        if (currentUsage) {
            items.push({
                label: '$(star) Current Active Session / 当前活跃会话',
                kind: vscode.QuickPickItemKind.Separator
            });

            const remaining = Math.max(0, currentUsage.contextLimit - currentUsage.contextUsed);
            const compressionStats = calculateCompressionStats(currentUsage);
            const sourceTag = currentUsage.isEstimated ? '[Est/估算]' : '[Precise/精确]';
            const compressTag = currentUsage.compressionDetected ? ' [Compressed/已压缩]' : (currentUsage.usagePercent > 100 ? ' [Compressing/压缩中]' : '');
            const imageTag = currentUsage.imageGenStepCount > 0 ? ` [📷×${currentUsage.imageGenStepCount}]` : '';
            const gapsTag = currentUsage.hasGaps ? ' [⚠️Gaps/缺失]' : '';
            const compDetail = compressionStats
                ? `Compression/压缩量: ${compressionStats.dropTokens.toLocaleString()} tokens ` +
                `(${compressionStats.dropPercent.toFixed(1)}%, ${compressionStats.source === 'context' ? 'context' : 'checkpoint'})`
                : null;
            // m6: Use newline-separated detail for readability
            items.push({
                label: `$(pulse) ${currentUsage.title || 'Current Session / 当前会话'}`,
                description: `${currentUsage.modelDisplayName}`,
                detail: [
                    `${sourceTag}${compressTag}${imageTag}${gapsTag}`,
                    `Used/已用: ${currentUsage.contextUsed.toLocaleString()} tokens | Limit/上限: ${currentUsage.contextLimit.toLocaleString()} tokens`,
                    `Model Out/模型输出: ${currentUsage.totalOutputTokens.toLocaleString()} | Tool Out/工具结果: ${currentUsage.totalToolCallOutputTokens.toLocaleString()}`,
                    `Remaining/剩余: ${remaining.toLocaleString()} tokens | Usage/使用率: ${currentUsage.usagePercent.toFixed(1)}% | Steps/步骤: ${currentUsage.stepCount}`,
                    ...(compDetail ? [compDetail] : [])
                ].join('\n')
            });
        }

        // Other conversations
        const others = allTrajectoryUsages.filter(u => u.cascadeId !== currentUsage?.cascadeId);
        if (others.length > 0) {
            items.push({
                label: '$(list-tree) Other Sessions / 其他会话',
                kind: vscode.QuickPickItemKind.Separator
            });

            for (const usage of others.slice(0, 10)) {
                const remaining = Math.max(0, usage.contextLimit - usage.contextUsed);
                const compressionStats = calculateCompressionStats(usage);
                const sourceTag = usage.isEstimated ? 'E/估' : 'P/精';
                const imageTag = usage.imageGenStepCount > 0 ? ` 📷×${usage.imageGenStepCount}` : '';
                const compTag = usage.compressionDetected ? ' 🗜' : '';
                const compDetail = compressionStats
                    ? `Comp/压缩: -${formatTokenCount(compressionStats.dropTokens)} (${compressionStats.dropPercent.toFixed(1)}%)`
                    : null;
                items.push({
                    label: `$(comment) ${usage.title || usage.cascadeId.substring(0, 8)}`,
                    description: `${usage.modelDisplayName} | ${usage.usagePercent.toFixed(1)}%${imageTag}${compTag}`,
                    detail: [
                        `[${sourceTag}] Used/已用: ${formatTokenCount(usage.contextUsed)} / ${formatContextLimit(usage.contextLimit)}`,
                        `MdlOut/模型出: ${formatTokenCount(usage.totalOutputTokens)} | ToolOut/工具出: ${formatTokenCount(usage.totalToolCallOutputTokens)}`,
                        `Rem/余: ${formatTokenCount(remaining)} | ${usage.stepCount} steps/步`,
                        ...(compDetail ? [compDetail] : [])
                    ].join('\n')
                });
            }
        }

        await vscode.window.showQuickPick(items, {
            title: '📊 Antigravity Context Window Monitor / 上下文窗口使用情况',
            placeHolder: 'View context details for all sessions / 查看各会话的上下文使用详情',
            canPickMany: false
        });
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}
