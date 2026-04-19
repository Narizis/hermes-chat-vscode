import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UsageInfo } from './types';

const USAGE_DIR = path.join(os.homedir(), '.hermes', 'usage');
const USAGE_FILE = path.join(USAGE_DIR, 'usage.jsonl');

interface UsageRecord {
    timestamp: number;
    model?: string;
    provider?: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    thoughtTokens: number;
    cachedReadTokens: number;
}

export interface AggregatedUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    thoughtTokens: number;
    cachedReadTokens: number;
    messageCount: number;
}

const EMPTY: AggregatedUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, thoughtTokens: 0, cachedReadTokens: 0, messageCount: 0 };

export class UsageStore {
    record(usage: UsageInfo, model?: string, provider?: string): void {
        if (!fs.existsSync(USAGE_DIR)) fs.mkdirSync(USAGE_DIR, { recursive: true });
        const record: UsageRecord = {
            timestamp: Date.now(),
            model,
            provider,
            inputTokens: usage.inputTokens || 0,
            outputTokens: usage.outputTokens || 0,
            totalTokens: usage.totalTokens || 0,
            thoughtTokens: usage.thoughtTokens || 0,
            cachedReadTokens: usage.cachedReadTokens || 0,
        };
        fs.appendFileSync(USAGE_FILE, JSON.stringify(record) + '\n');
    }

    query(period: 'day' | 'week' | 'month' | 'all'): AggregatedUsage {
        if (!fs.existsSync(USAGE_FILE)) return { ...EMPTY };

        const now = Date.now();
        const cutoff = period === 'all' ? 0
            : period === 'month' ? now - 30 * 86400000
            : period === 'week' ? now - 7 * 86400000
            : now - startOfDayOffset(now);

        const agg: AggregatedUsage = { ...EMPTY };
        const lines = fs.readFileSync(USAGE_FILE, 'utf8').split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const r: UsageRecord = JSON.parse(line);
                if (r.timestamp >= cutoff) {
                    agg.inputTokens += r.inputTokens;
                    agg.outputTokens += r.outputTokens;
                    agg.totalTokens += r.totalTokens;
                    agg.thoughtTokens += r.thoughtTokens;
                    agg.cachedReadTokens += r.cachedReadTokens;
                    agg.messageCount++;
                }
            } catch { /* skip malformed lines */ }
        }
        return agg;
    }
}

function startOfDayOffset(now: number): number {
    const d = new Date(now);
    return now - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
