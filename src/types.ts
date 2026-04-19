export interface HermesResponse {
    content: string;
    sessionId: string | null;
}

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
    toolCalls?: ToolCallInfo[];
    usage?: UsageInfo;
}

export interface ToolCallInfo {
    id: string;
    name: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    args?: unknown;
    result?: string;
}

export interface UsageInfo {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    thoughtTokens?: number;
    cachedReadTokens?: number;
}

export interface MemoryEntry {
    content: string;
    file: string;
}

export interface SkillInfo {
    name: string;
    path: string;
    description?: string;
}

export interface CronJob {
    id: string;
    schedule: string;
    prompt: string;
    enabled: boolean;
}

export interface HermesSession {
    id: string;
    title: string;
    date: string;
}
