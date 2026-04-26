import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UsageStore, AggregatedUsage } from './usage-store';

const HERMES_HOME = path.join(os.homedir(), '.hermes');

// ============================================================
// Memory Panel
// ============================================================

export class MemoryTreeProvider implements vscode.TreeDataProvider<MemoryItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<MemoryItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh() { this._onDidChangeTreeData.fire(undefined); }

    getTreeItem(el: MemoryItem) { return el; }

    async getChildren(el?: MemoryItem): Promise<MemoryItem[]> {
        if (el) return [];

        const items: MemoryItem[] = [];
        const userMd = path.join(HERMES_HOME, 'memories', 'USER.md');
        const memoryMd = path.join(HERMES_HOME, 'memories', 'MEMORY.md');
        const soulMd = path.join(HERMES_HOME, 'SOUL.md');

        if (fs.existsSync(userMd)) items.push(new MemoryItem('About You (USER.md)', userMd, 'file', vscode.TreeItemCollapsibleState.None));
        if (fs.existsSync(memoryMd)) items.push(new MemoryItem('Project Memory (MEMORY.md)', memoryMd, 'file', vscode.TreeItemCollapsibleState.None));
        if (fs.existsSync(soulMd)) items.push(new MemoryItem('Personality (SOUL.md)', soulMd, 'file', vscode.TreeItemCollapsibleState.None));
        if (items.length === 0) {
            items.push(new MemoryItem('No memories yet — chat with Hermes to build memory', '', 'empty', vscode.TreeItemCollapsibleState.None));
        }
        return items;
    }
}

export class MemoryItem extends vscode.TreeItem {
    entryIndex?: number;
    constructor(
        label: string,
        public readonly filePath: string,
        public readonly kind: 'file' | 'entry' | 'empty',
        collapsibleState: vscode.TreeItemCollapsibleState,
    ) {
        super(label, collapsibleState);
        if (kind === 'file') {
            this.iconPath = new vscode.ThemeIcon('book');
            this.contextValue = 'memoryFile';
            this.command = {
                command: 'vscode.open',
                title: 'Open Memory File',
                arguments: [vscode.Uri.file(filePath)],
            };
        } else if (kind === 'entry') {
            this.iconPath = new vscode.ThemeIcon('note');
        } else {
            this.iconPath = new vscode.ThemeIcon('info');
        }
    }
}

// ============================================================
// Skills Panel
// ============================================================

export class SkillsTreeProvider implements vscode.TreeDataProvider<SkillItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SkillItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh() { this._onDidChangeTreeData.fire(undefined); }

    getTreeItem(el: SkillItem) { return el; }

    async getChildren(el?: SkillItem): Promise<SkillItem[]> {
        const skillsDir = path.join(HERMES_HOME, 'skills');
        if (!fs.existsSync(skillsDir)) {
            return [new SkillItem('Skills directory not found', '', 'empty')];
        }

        if (!el) {
            try {
                const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
                return entries
                    .filter((e) => e.isDirectory())
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((e) => new SkillItem(e.name, path.join(skillsDir, e.name), 'category'));
            } catch {
                return [];
            }
        }

        if (el.kind === 'category') {
            try {
                const entries = fs.readdirSync(el.dirPath, { withFileTypes: true });
                return entries
                    .filter((e) => e.isDirectory())
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((e) => new SkillItem(e.name, path.join(el.dirPath, e.name), 'skill'));
            } catch {
                return [];
            }
        }
        return [];
    }
}

export class SkillItem extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly dirPath: string,
        public readonly kind: 'category' | 'skill' | 'empty',
    ) {
        super(label, kind === 'skill' || kind === 'empty' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
        if (kind === 'category') {
            this.iconPath = new vscode.ThemeIcon('folder');
        } else if (kind === 'skill') {
            this.iconPath = new vscode.ThemeIcon('sparkle');
            this.contextValue = 'skill';
            const skillMd = path.join(dirPath, 'SKILL.md');
            if (fs.existsSync(skillMd)) {
                this.command = {
                    command: 'vscode.open',
                    title: 'Open Skill',
                    arguments: [vscode.Uri.file(skillMd)],
                };
            }
        } else {
            this.iconPath = new vscode.ThemeIcon('info');
        }
    }
}

// ============================================================
// Cron Panel
// ============================================================

interface CronJobData {
    id: string;
    name: string;
    prompt: string;
    schedule_display?: string;
    enabled: boolean;
    state: string;
    next_run_at?: string;
    last_run_at?: string;
    last_status?: string;
    last_error?: string;
}

export class CronTreeProvider implements vscode.TreeDataProvider<CronItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<CronItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh() { this._onDidChangeTreeData.fire(undefined); }

    getTreeItem(el: CronItem) { return el; }

    async getChildren(): Promise<CronItem[]> {
        const jobsFile = path.join(HERMES_HOME, 'cron', 'jobs.json');
        if (!fs.existsSync(jobsFile)) {
            return [new CronItem('No cron jobs yet', '', undefined, 'empty')];
        }

        try {
            const data = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
            const jobs: CronJobData[] = data.jobs || [];
            if (jobs.length === 0) {
                return [new CronItem('No cron jobs scheduled', '', undefined, 'empty')];
            }
            return jobs.map((job) => new CronItem(job.name, job.id, job, 'job'));
        } catch (e) {
            return [new CronItem(`Error reading jobs: ${e}`, '', undefined, 'empty')];
        }
    }
}

export class CronItem extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly jobId: string,
        public readonly job: CronJobData | undefined,
        public readonly kind: 'job' | 'empty',
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        if (kind === 'job' && job) {
            const enabled = job.enabled;
            const status = job.last_status || 'pending';
            this.iconPath = new vscode.ThemeIcon(
                enabled
                    ? (status === 'error' ? 'warning' : 'clock')
                    : 'circle-slash',
            );
            const next = job.next_run_at ? new Date(job.next_run_at).toLocaleString() : 'n/a';
            this.description = `${job.schedule_display || ''} · next: ${next}`;
            this.tooltip = new vscode.MarkdownString(
                `**${job.name}**\n\n` +
                `Schedule: \`${job.schedule_display || ''}\`\n\n` +
                `Prompt: ${job.prompt}\n\n` +
                `State: ${job.state}${enabled ? '' : ' (disabled)'}\n\n` +
                `Last status: ${status}${job.last_error ? `\n\nLast error: \`${job.last_error}\`` : ''}\n\n` +
                `Next run: ${next}`,
            );
            this.contextValue = 'cronJob';
        } else {
            this.iconPath = new vscode.ThemeIcon('info');
        }
    }
}

// ============================================================
// Model Panel
// ============================================================

interface HermesConfig {
    model?: {
        default?: string;
        provider?: string;
        base_url?: string;
        api_mode?: string;
    };
}

const PROVIDER_MODELS: Record<string, string[]> = {
    copilot: [
        'claude-opus-4.7',
        'claude-opus-4.6',
        'claude-sonnet-4.6',
        'claude-sonnet-4.5',
        'claude-haiku-4.5',
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-5-mini',
        'gpt-4.1',
        'gpt-4o',
        'gpt-4o-mini',
        'gemini-2.5-pro',
        'grok-code-fast-1',
    ],
    nous: [
        'anthropic/claude-opus-4.6',
        'anthropic/claude-sonnet-4.6',
        'anthropic/claude-haiku-4.5',
        'openai/gpt-5.4',
        'openai/gpt-5.4-mini',
        'google/gemini-3-pro-preview',
        'google/gemini-3-flash-preview',
    ],
    anthropic: [
        'claude-opus-4.7',
        'claude-opus-4.6',
        'claude-sonnet-4.6',
        'claude-sonnet-4.5',
        'claude-haiku-4.5',
    ],
    openai: [
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-4.1',
        'gpt-4o',
    ],
};

function readHermesConfig(): HermesConfig {
    const configPath = path.join(HERMES_HOME, 'config.yaml');
    if (!fs.existsSync(configPath)) return {};
    try {
        const text = fs.readFileSync(configPath, 'utf8');
        const model: HermesConfig['model'] = {};
        const lines = text.split('\n');
        let inModel = false;
        for (const line of lines) {
            if (/^model\s*:/.test(line)) { inModel = true; continue; }
            if (inModel && /^\S/.test(line)) { inModel = false; continue; }
            if (inModel) {
                const m = line.match(/^\s+(default|provider|base_url|api_mode)\s*:\s*(.+)/);
                if (m) {
                    (model as Record<string, string>)[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
                }
            }
        }
        return { model };
    } catch {
        return {};
    }
}

export class ModelTreeProvider implements vscode.TreeDataProvider<ModelItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ModelItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _activeModel: string | null = null;
    private _activeProvider: string | null = null;

    refresh() { this._onDidChangeTreeData.fire(undefined); }

    setActiveModel(model: string, provider?: string) {
        this._activeModel = model;
        if (provider) this._activeProvider = provider;
        this.refresh();
    }

    getActiveModel(): string | null {
        if (this._activeModel) return this._activeModel;
        return readHermesConfig().model?.default || null;
    }

    getActiveProvider(): string | null {
        if (this._activeProvider) return this._activeProvider;
        return readHermesConfig().model?.provider || null;
    }

    getProviders(): string[] {
        return Object.keys(PROVIDER_MODELS);
    }

    getTreeItem(el: ModelItem) { return el; }

    async getChildren(el?: ModelItem): Promise<ModelItem[]> {
        const config = readHermesConfig();
        const currentProvider = this._activeProvider || config.model?.provider || 'auto';
        const currentModel = this._activeModel || config.model?.default || 'unknown';

        if (!el) {
            return Object.keys(PROVIDER_MODELS).map((p) => {
                const isCurrent = p === currentProvider;
                const item = new ModelItem(p, 'provider');
                item.description = isCurrent ? 'current' : '';
                item.iconPath = new vscode.ThemeIcon(isCurrent ? 'cloud-upload' : 'cloud');
                item.collapsibleState = isCurrent
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.Collapsed;
                item.contextValue = 'provider';
                return item;
            });
        }

        if (el.kind === 'provider') {
            const providerName = typeof el.label === 'string' ? el.label : '';
            const models = PROVIDER_MODELS[providerName] || [];
            return models.map((m) => {
                const isActive = providerName === currentProvider && m === currentModel;
                const item = new ModelItem(m, 'model');
                item.iconPath = new vscode.ThemeIcon(isActive ? 'check' : 'circle-outline');
                item.description = isActive ? 'active' : '';
                item.command = {
                    command: 'hermes-chat.selectModel',
                    title: 'Select Model',
                    arguments: [providerName, m],
                };
                return item;
            });
        }

        return [];
    }

    getModelsForProvider(provider?: string): string[] {
        const p = provider || this._activeProvider || readHermesConfig().model?.provider || 'copilot';
        return PROVIDER_MODELS[p] || PROVIDER_MODELS.copilot;
    }
}

export class ModelItem extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly kind: 'provider' | 'model',
    ) {
        super(label, kind === 'provider'
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None);
        if (kind === 'provider') {
            this.iconPath = new vscode.ThemeIcon('cloud');
        } else {
            this.iconPath = new vscode.ThemeIcon('circle-outline');
        }
    }
}

// ============================================================
// Usage Panel
// ============================================================

function formatTokens(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(n);
}

export class UsageTreeProvider implements vscode.TreeDataProvider<UsageItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<UsageItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private store = new UsageStore();

    refresh() { this._onDidChangeTreeData.fire(undefined); }

    getTreeItem(el: UsageItem) { return el; }

    async getChildren(): Promise<UsageItem[]> {
        const periods: { label: string; period: 'day' | 'week' | 'month' | 'all'; icon: string }[] = [
            { label: 'Today', period: 'day', icon: 'calendar' },
            { label: 'This Week', period: 'week', icon: 'calendar' },
            { label: 'This Month', period: 'month', icon: 'calendar' },
            { label: 'All Time', period: 'all', icon: 'history' },
        ];

        return Promise.all(periods.map(async ({ label, period, icon }) => {
            const agg = await this.store.query(period);
            return new UsageItem(label, agg, icon);
        }));
    }
}

export class UsageItem extends vscode.TreeItem {
    constructor(label: string, agg: AggregatedUsage, icon: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
        if (agg.messageCount === 0) {
            this.description = 'no usage';
        } else {
            this.description = `↑${formatTokens(agg.inputTokens)} ↓${formatTokens(agg.outputTokens)} · ${agg.messageCount} msgs`;
        }
        this.tooltip = new vscode.MarkdownString(
            `**${label}**\n\n` +
            `Input: ${agg.inputTokens.toLocaleString()}\n\n` +
            `Output: ${agg.outputTokens.toLocaleString()}\n\n` +
            `Thought: ${agg.thoughtTokens.toLocaleString()}\n\n` +
            `Cached: ${agg.cachedReadTokens.toLocaleString()}\n\n` +
            `Total: ${agg.totalTokens.toLocaleString()}\n\n` +
            `Messages: ${agg.messageCount}`,
        );
    }
}
