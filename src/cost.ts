// ─── API Cost Calculator ─────────────────────────────────────────────────────
// Calculates equivalent API costs based on model pricing.
// Prices are per 1M tokens in USD.

export interface ModelPricing {
    displayName: string;
    inputPerMillion: number;
    outputPerMillion: number;
}

// Model pricing table — covers both placeholder and actual model IDs
const PRICING: Record<string, ModelPricing> = {
    // Placeholder model IDs (from Antigravity LS)
    'MODEL_PLACEHOLDER_M37': { displayName: 'Gemini 3.1 Pro (H)', inputPerMillion: 1.25, outputPerMillion: 10.00 },
    'MODEL_PLACEHOLDER_M36': { displayName: 'Gemini 3.1 Pro (L)', inputPerMillion: 1.25, outputPerMillion: 10.00 },
    'MODEL_PLACEHOLDER_M18': { displayName: 'Gemini 3 Flash', inputPerMillion: 0.15, outputPerMillion: 0.60 },
    'MODEL_PLACEHOLDER_M35': { displayName: 'Claude Sonnet 4.6', inputPerMillion: 3.00, outputPerMillion: 15.00 },
    'MODEL_PLACEHOLDER_M26': { displayName: 'Claude Opus 4.6', inputPerMillion: 5.00, outputPerMillion: 25.00 },
    // Actual model IDs
    'MODEL_GOOGLE_GEMINI_2_5_PRO': { displayName: 'Gemini 2.5 Pro', inputPerMillion: 1.25, outputPerMillion: 10.00 },
    'MODEL_GOOGLE_GEMINI_2_5_FLASH': { displayName: 'Gemini 2.5 Flash', inputPerMillion: 0.15, outputPerMillion: 0.60 },
    'MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE': { displayName: 'Gemini 2.5 Flash Lite', inputPerMillion: 0.15, outputPerMillion: 0.60 },
    'MODEL_ANTHROPIC_CLAUDE_OPUS': { displayName: 'Claude Opus 4', inputPerMillion: 5.00, outputPerMillion: 25.00 },
    'MODEL_ANTHROPIC_CLAUDE_SONNET': { displayName: 'Claude Sonnet 4', inputPerMillion: 3.00, outputPerMillion: 15.00 },
    'MODEL_OPENAI_GPT_OSS_120B_MEDIUM': { displayName: 'GPT-OSS 120B', inputPerMillion: 1.25, outputPerMillion: 10.00 },
};

const DEFAULT_PRICING: ModelPricing = {
    displayName: 'Unknown',
    inputPerMillion: 1.25,
    outputPerMillion: 10.00,
};

/**
 * Get pricing info for a model.
 */
export function getModelPricing(modelId: string): ModelPricing {
    return PRICING[modelId] || DEFAULT_PRICING;
}

/**
 * Calculate equivalent API cost in USD.
 */
export function calculateCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number
): number {
    const pricing = getModelPricing(modelId);
    return (inputTokens * pricing.inputPerMillion +
        outputTokens * pricing.outputPerMillion) / 1_000_000;
}

/**
 * Format cost as string with dollar sign.
 */
export function formatCost(cost: number): string {
    if (cost < 0.01) { return '<$0.01'; }
    if (cost < 1.00) { return `$${cost.toFixed(2)}`; }
    return `$${cost.toFixed(2)}`;
}

/**
 * Generate cost breakdown tooltip text.
 */
export function costTooltipLines(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    cost: number
): string[] {
    const pricing = getModelPricing(modelId);
    const inCost = (inputTokens * pricing.inputPerMillion) / 1_000_000;
    const outCost = (outputTokens * pricing.outputPerMillion) / 1_000_000;
    return [
        `💰 等效 API 费用 / Equiv. API Cost: ${formatCost(cost)}`,
        `   输入 / Input: ${(inputTokens / 1000).toFixed(1)}k × $${pricing.inputPerMillion}/1M = ${formatCost(inCost)}`,
        `   输出 / Output: ${(outputTokens / 1000).toFixed(1)}k × $${pricing.outputPerMillion}/1M = ${formatCost(outCost)}`,
    ];
}

// ─── Segmented Cost Calculation ───────────────────────────────────────────────

export interface PerModelCostSegment {
    model: string;
    displayName: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
}

/**
 * Calculate per-model cost segments from checkpoint usage data.
 * Groups checkpoint usages by model and sums tokens/costs for each.
 */
export function calculateSegmentedCost(
    checkpointUsages: Array<{ model: string; inputTokens: number; outputTokens: number }>
): { total: number; segments: PerModelCostSegment[] } {
    const byModel = new Map<string, { input: number; output: number }>();
    for (const cp of checkpointUsages) {
        const key = cp.model || 'unknown';
        const existing = byModel.get(key) || { input: 0, output: 0 };
        existing.input += cp.inputTokens;
        existing.output += cp.outputTokens;
        byModel.set(key, existing);
    }

    let total = 0;
    const segments: PerModelCostSegment[] = [];
    for (const [model, tokens] of byModel.entries()) {
        const pricing = getModelPricing(model);
        const cost = (tokens.input * pricing.inputPerMillion +
            tokens.output * pricing.outputPerMillion) / 1_000_000;
        total += cost;
        segments.push({
            model,
            displayName: pricing.displayName,
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            cost
        });
    }
    return { total, segments };
}

/**
 * Generate segmented cost tooltip lines for multi-model conversations.
 */
export function segmentedCostTooltipLines(
    segments: PerModelCostSegment[],
    total: number
): string[] {
    const lines: string[] = [
        `💰 等效 API 费用 / Equiv. API Cost: ${formatCost(total)} (segmented / 分段)`,
    ];
    for (const seg of segments) {
        const pricing = getModelPricing(seg.model);
        lines.push(
            `   ${seg.displayName}: In ${(seg.inputTokens / 1000).toFixed(1)}k×$${pricing.inputPerMillion}/1M` +
            ` + Out ${(seg.outputTokens / 1000).toFixed(1)}k×$${pricing.outputPerMillion}/1M = ${formatCost(seg.cost)}`
        );
    }
    return lines;
}
