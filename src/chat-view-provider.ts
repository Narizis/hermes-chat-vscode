import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AcpClient, SessionUpdate } from './acp-client';
import { ChatMessage, ToolCallInfo, UsageInfo } from './types';
import { UsageStore } from './usage-store';

interface AttachedContextFile {
    path: string;
    label: string;
    content: string;
    truncated: boolean;
}

interface WorkspaceTreeNode {
    id: string;
    label: string;
    kind: 'folder' | 'file';
    path?: string;
    children?: WorkspaceTreeNode[];
}

interface StatusBadgeInfo {
    label: string;
    detail: string;
    level: 'ready' | 'warning';
}

interface StatusDetailsInfo {
    title: string;
    summary: string;
    level: 'ready' | 'warning';
    items: string[];
}

export class HermesChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'hermes-chat.chatView';
    public static readonly panelViewType = 'hermes-chat.chatPanel';
    private static readonly maxAttachedFileBytes = 20_000;
    private static readonly maxAttachedFiles = 6;
    private static readonly maxStoredMessages = 500;

    private sidebarView?: vscode.WebviewView;
    private panel?: vscode.WebviewPanel;
    private messages: ChatMessage[] = [];
    private sessionId: string | null = null;
    private isProcessing = false;
    private acp: AcpClient | null = null;
    private context: vscode.ExtensionContext;
    private currentAssistantMessage: ChatMessage | null = null;
    private currentToolCalls = new Map<string, ToolCallInfo>();
    private usageStore = new UsageStore();
    private attachedFiles: AttachedContextFile[] = [];
    private resumeFailedNoticeShown = false;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.sessionId = context.workspaceState.get('hermes-chat.sessionId', null);

        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.syncViewState()),
            vscode.window.onDidChangeTextEditorSelection(() => this.syncViewState()),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('hermes-chat')) {
                    this.syncViewState();
                }
            }),
        );
    }

    private getHermesPath(): string {
        return vscode.workspace.getConfiguration('hermes-chat').get('hermesPath', 'hermes');
    }

    private getRequestTimeoutMs(): number {
        const seconds = vscode.workspace.getConfiguration('hermes-chat').get('timeout', 180);
        return Math.max(1, seconds) * 1000;
    }

    private appendMessage(message: ChatMessage): void {
        this.messages.push(message);
        const max = HermesChatViewProvider.maxStoredMessages;
        if (this.messages.length > max) {
            this.messages.splice(0, this.messages.length - max);
        }
    }

    private async ensureAcp(): Promise<AcpClient> {
        if (this.acp && this.acp.isReady()) return this.acp;

        if (this.acp) this.acp.stop();

        const client = new AcpClient(this.getHermesPath(), this.getRequestTimeoutMs());
        client.on('sessionUpdate', (evt: SessionUpdate) => this.handleSessionUpdate(evt));
        client.on('exit', (code: number | null) => {
            this.postMessage({ type: 'showError', error: `Hermes ACP exited (code ${code}). Will restart on next message.` });
            this.acp = null;
        });
        client.on('error', (err: Error) => {
            this.postMessage({ type: 'showError', error: `Hermes error: ${err.message}` });
        });

        await client.start();

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

        if (this.sessionId) {
            const ok = await client.resumeSession(this.sessionId, cwd);
            if (!ok) {
                if (!this.resumeFailedNoticeShown) {
                    void vscode.window.showWarningMessage(
                        'The previous Hermes session could not be restored. A new session was started, so cross-turn recall may be incomplete until session search is used.',
                    );
                    this.resumeFailedNoticeShown = true;
                }
                this.sessionId = await client.newSession(cwd);
                this.context.workspaceState.update('hermes-chat.sessionId', this.sessionId);
            }
        } else {
            this.sessionId = await client.newSession(cwd);
            this.context.workspaceState.update('hermes-chat.sessionId', this.sessionId);
        }

        this.acp = client;
        this.syncViewState();
        return client;
    }

    private getWorkspaceCwd(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    }

    private getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
        return vscode.workspace.workspaceFolders || [];
    }

    private getHermesHome(): string {
        return path.join(os.homedir(), '.hermes');
    }

    private readHermesConfigText(): string {
        const configPath = path.join(this.getHermesHome(), 'config.yaml');
        try {
            return fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
        } catch {
            return '';
        }
    }

    private getConfigValue(section: string, key: string): string | null {
        const text = this.readHermesConfigText();
        if (!text) return null;
        const lines = text.split('\n');
        let inSection = false;
        for (const line of lines) {
            if (new RegExp(`^${section}\\s*:`).test(line)) {
                inSection = true;
                continue;
            }
            if (inSection && /^\S/.test(line)) {
                inSection = false;
                continue;
            }
            if (inSection) {
                const match = line.match(new RegExp(`^\\s+${key}\\s*:\\s*(.+)`));
                if (match) return match[1].replace(/^['"]|['"]$/g, '').trim();
            }
        }
        return null;
    }

    private getRecallStatus(): StatusBadgeInfo {
        const stateDbPath = path.join(this.getHermesHome(), 'state.db');
        if (this.resumeFailedNoticeShown) {
            return {
                label: 'Recall',
                detail: 'Session restore failed',
                level: 'warning',
            };
        }
        if (fs.existsSync(stateDbPath)) {
            return {
                label: 'Recall',
                detail: 'Session DB ready',
                level: 'ready',
            };
        }
        return {
            label: 'Recall',
            detail: 'No session DB yet',
            level: 'warning',
        };
    }

    private getRecallDetails(): StatusDetailsInfo {
        const stateDbPath = path.join(this.getHermesHome(), 'state.db');
        const items = [
            `Session ID: ${this.sessionId || 'none'}`,
            `State DB: ${stateDbPath}${fs.existsSync(stateDbPath) ? ' (present)' : ' (missing)'}`,
            `Resume warning shown: ${this.resumeFailedNoticeShown ? 'yes' : 'no'}`,
        ];
        if (this.resumeFailedNoticeShown) {
            items.push('The most recent ACP restore attempt failed, so this editor session started a new Hermes session.');
        }
        return {
            title: 'Recall Diagnostics',
            summary: fs.existsSync(stateDbPath) && !this.resumeFailedNoticeShown
                ? 'Session history storage looks available.'
                : 'Session recall is degraded or not initialized.',
            level: this.getRecallStatus().level,
            items,
        };
    }

    private getMemoryStatus(): StatusBadgeInfo {
        const memoryProvider = this.getConfigValue('memory', 'provider');
        if (memoryProvider) {
            return {
                label: 'Memory',
                detail: memoryProvider,
                level: 'ready',
            };
        }

        const hermesHome = this.getHermesHome();
        const memoryFiles = [
            path.join(hermesHome, 'memories', 'USER.md'),
            path.join(hermesHome, 'memories', 'MEMORY.md'),
            path.join(hermesHome, 'SOUL.md'),
        ];
        if (memoryFiles.some((file) => fs.existsSync(file))) {
            return {
                label: 'Memory',
                detail: 'Local memory files',
                level: 'ready',
            };
        }

        return {
            label: 'Memory',
            detail: 'Not initialized',
            level: 'warning',
        };
    }

    private getMemoryDetails(): StatusDetailsInfo {
        const memoryProvider = this.getConfigValue('memory', 'provider');
        const hermesHome = this.getHermesHome();
        const memoryFiles = [
            path.join(hermesHome, 'memories', 'USER.md'),
            path.join(hermesHome, 'memories', 'MEMORY.md'),
            path.join(hermesHome, 'SOUL.md'),
        ];
        const presentFiles = memoryFiles.filter((file) => fs.existsSync(file));
        return {
            title: 'Memory Diagnostics',
            summary: memoryProvider
                ? `Configured provider: ${memoryProvider}`
                : presentFiles.length
                    ? 'Using local memory files.'
                    : 'No memory provider or local memory files detected.',
            level: this.getMemoryStatus().level,
            items: [
                `Configured provider: ${memoryProvider || 'none'}`,
                `Local memory files: ${presentFiles.length ? presentFiles.map((file) => path.basename(file)).join(', ') : 'none'}`,
                `Hermes home: ${hermesHome}`,
            ],
        };
    }

    private inferToolFailure(rawOutput: unknown): boolean {
        if (rawOutput == null) return false;
        const text = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
        try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object') {
                if (parsed.success === false) return true;
                if (typeof parsed.error === 'string' && parsed.error.trim()) return true;
            }
        } catch {
            // Ignore non-JSON tool output.
        }
        return false;
    }

    private async loadAttachedFile(uri: vscode.Uri): Promise<AttachedContextFile> {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const truncated = bytes.byteLength > HermesChatViewProvider.maxAttachedFileBytes;
        const contentBytes = truncated ? bytes.slice(0, HermesChatViewProvider.maxAttachedFileBytes) : bytes;
        const content = new TextDecoder('utf-8', { fatal: false }).decode(contentBytes);
        return {
            path: uri.fsPath,
            label: vscode.workspace.asRelativePath(uri),
            content,
            truncated,
        };
    }

    private async getWorkspaceFileCandidates(): Promise<vscode.Uri[]> {
        return vscode.workspace.findFiles(
            '**/*',
            '**/{node_modules,.git,.next,dist,build,out,coverage,venv,.venv}/**',
            2000,
        );
    }

    private async buildWorkspaceTree(): Promise<WorkspaceTreeNode[]> {
        const folders = this.getWorkspaceFolders();
        const candidates = await this.getWorkspaceFileCandidates();
        const trees = new Map<string, WorkspaceTreeNode>();

        for (const folder of folders) {
            trees.set(folder.uri.fsPath, {
                id: folder.uri.fsPath,
                label: folder.name,
                kind: 'folder',
                children: [],
            });
        }

        for (const uri of candidates) {
            const folder = folders.find((item) => uri.fsPath.startsWith(item.uri.fsPath));
            if (!folder) continue;

            const relative = path.relative(folder.uri.fsPath, uri.fsPath);
            const segments = relative.split(/[\\/]/).filter(Boolean);
            if (!segments.length) continue;

            let current: WorkspaceTreeNode | undefined = trees.get(folder.uri.fsPath);
            if (!current || !current.children) continue;

            const pathParts = [folder.name];
            for (let index = 0; index < segments.length; index++) {
                if (!current.children) break;
                const segment = segments[index];
                pathParts.push(segment);
                const isFile = index === segments.length - 1;
                let next: WorkspaceTreeNode | undefined = current.children.find(
                    (child) => child.label === segment && child.kind === (isFile ? 'file' : 'folder'),
                );
                if (!next) {
                    next = {
                        id: `${folder.uri.fsPath}:${pathParts.join('/')}`,
                        label: segment,
                        kind: isFile ? 'file' : 'folder',
                        path: isFile ? uri.fsPath : undefined,
                        children: isFile ? undefined : [],
                    };
                    current.children.push(next);
                    current.children.sort((a, b) => {
                        if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
                        return a.label.localeCompare(b.label);
                    });
                }
                current = next;
            }
        }

        return Array.from(trees.values());
    }

    private async attachFileByPath(filePath: string): Promise<void> {
        if (this.attachedFiles.some((file) => file.path === filePath)) return;
        if (this.attachedFiles.length >= HermesChatViewProvider.maxAttachedFiles) {
            void vscode.window.showWarningMessage(`You can attach up to ${HermesChatViewProvider.maxAttachedFiles} files per message context.`);
            return;
        }

        try {
            const file = await this.loadAttachedFile(vscode.Uri.file(filePath));
            this.attachedFiles.push(file);
            this.postMessage({ type: 'attachmentsChanged', files: this.attachedFiles });
            this.syncViewState();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showWarningMessage(`Failed to attach ${vscode.workspace.asRelativePath(vscode.Uri.file(filePath))}: ${message}`);
        }
    }

    private async toggleAttachedFile(filePath: string, checked: boolean): Promise<void> {
        if (checked) {
            await this.attachFileByPath(filePath);
            return;
        }
        this.removeAttachedFile(filePath);
    }

    private removeAttachedFile(filePath: string): void {
        this.attachedFiles = this.attachedFiles.filter((file) => file.path !== filePath);
        this.postMessage({ type: 'attachmentsChanged', files: this.attachedFiles });
        this.syncViewState();
    }

    private clearAttachedFiles(): void {
        if (!this.attachedFiles.length) return;
        this.attachedFiles = [];
        this.postMessage({ type: 'attachmentsChanged', files: [] });
        this.syncViewState();
    }

    private getEditorContextInfo(): Record<string, unknown> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return {
                fileLabel: 'No active editor',
                detail: this.attachedFiles.length
                    ? `${this.attachedFiles.length} attached file${this.attachedFiles.length === 1 ? '' : 's'} will be included.`
                    : 'Your prompt will be sent without file context.',
                hasSelection: false,
            };
        }

        const filePath = vscode.workspace.asRelativePath(editor.document.uri);
        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);

        if (!selectedText) {
            return {
                fileLabel: filePath,
                detail: this.attachedFiles.length
                    ? `Active file plus ${this.attachedFiles.length} attached file${this.attachedFiles.length === 1 ? '' : 's'}.`
                    : 'Active file will be included automatically.',
                hasSelection: false,
            };
        }

        const selectedLines = selection.end.line - selection.start.line + 1;
        return {
            fileLabel: filePath,
            detail: `${selectedLines} selected line${selectedLines === 1 ? '' : 's'} in ${editor.document.languageId}${this.attachedFiles.length ? ` plus ${this.attachedFiles.length} attachment${this.attachedFiles.length === 1 ? '' : 's'}` : ''}`,
            hasSelection: true,
        };
    }

    private isHistoryRecallQuery(text: string): boolean {
        return /上次聊天|上次.*聊|之前聊过|之前说过|还记得|什么时候聊过|last chat|previous chat|earlier chat|remember when|when did we talk|last time/i.test(text);
    }

    private getViewStatePayload(): Record<string, unknown> {
        return {
            sessionId: this.sessionId,
            isProcessing: this.isProcessing,
            contextInfo: this.getEditorContextInfo(),
            recallStatus: this.getRecallStatus(),
            memoryStatus: this.getMemoryStatus(),
            recallDetails: this.getRecallDetails(),
            memoryDetails: this.getMemoryDetails(),
            attachedFiles: this.attachedFiles.map((file) => ({
                path: file.path,
                label: file.label,
                truncated: file.truncated,
            })),
        };
    }

    private getInitialWebviewState(mode: 'sidebar' | 'panel'): Record<string, unknown> {
        return {
            mode,
            messages: this.messages,
            currentAssistantMessage: this.currentAssistantMessage,
            workspaceTree: [],
            ...this.getViewStatePayload(),
        };
    }

    private async refreshWorkspaceTree(): Promise<void> {
        try {
            const tree = await this.buildWorkspaceTree();
            this.postMessage({ type: 'workspaceTree', tree });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.postMessage({ type: 'showError', error: `Failed to load workspace tree: ${message}` });
        }
    }

    private syncViewState(): void {
        this.postMessage({
            type: 'stateSync',
            ...this.getViewStatePayload(),
        });
    }

    private wireWebview(webview: vscode.Webview): vscode.Disposable {
        webview.options = { enableScripts: true };
        return webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'sendMessage':
                    await this.handleUserMessage(message.text);
                    break;
                case 'newSession':
                    await this.newSession();
                    break;
                case 'cancel':
                    this.acp?.cancel();
                    break;
                case 'openPanel':
                    this.openPanel();
                    break;
                case 'toggleAttachment':
                    if (typeof message.path === 'string') {
                        await this.toggleAttachedFile(message.path, Boolean(message.checked));
                    }
                    break;
                case 'removeAttachment':
                    if (typeof message.path === 'string') this.removeAttachedFile(message.path);
                    break;
                case 'clearAttachments':
                    this.clearAttachedFiles();
                    break;
            }
        });
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this.sidebarView = webviewView;
        webviewView.webview.html = this.getHtml('sidebar');

        const messageSub = this.wireWebview(webviewView.webview);
        webviewView.onDidDispose(() => {
            if (this.sidebarView === webviewView) this.sidebarView = undefined;
            messageSub.dispose();
        });

        this.syncViewState();
        void this.refreshWorkspaceTree();
    }

    openPanel(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active, true);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            HermesChatViewProvider.panelViewType,
            'Hermes Chat',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            },
        );
        this.panel.webview.html = this.getHtml('panel');
        const messageSub = this.wireWebview(this.panel.webview);
        this.panel.onDidDispose(() => {
            messageSub.dispose();
            this.panel = undefined;
        });
        this.syncViewState();
        void this.refreshWorkspaceTree();
    }

    async handleUserMessage(text: string) {
        if (this.isProcessing || !text.trim()) return;

        const query = this.buildQueryWithContext(text);
        const userMessage: ChatMessage = { role: 'user', content: text, timestamp: Date.now() };
        this.appendMessage(userMessage);
        this.postMessage({ type: 'addMessage', message: userMessage });

        this.isProcessing = true;
        this.postMessage({ type: 'setLoading', loading: true });
        this.syncViewState();

        // Prepare new assistant message for streaming
        this.currentAssistantMessage = {
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            toolCalls: [],
        };
        this.currentToolCalls.clear();
        this.postMessage({ type: 'startAssistantMessage', timestamp: this.currentAssistantMessage.timestamp });

        try {
            const client = await this.ensureAcp();
            const result = await client.prompt(query, this.sessionId ?? undefined);

            if (this.currentAssistantMessage) {
                this.currentAssistantMessage.usage = result.usage;
                this.appendMessage(this.currentAssistantMessage);
                this.postMessage({ type: 'finalizeAssistantMessage', usage: result.usage });
                if (result.usage) void this.usageStore.record(result.usage);
            }
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            this.postMessage({ type: 'showError', error: errorMsg });
        } finally {
            this.isProcessing = false;
            this.currentAssistantMessage = null;
            this.postMessage({ type: 'setLoading', loading: false });
            this.syncViewState();
        }
    }

    private handleSessionUpdate(evt: SessionUpdate): void {
        const update = evt.update;
        const kind = update.sessionUpdate;

        switch (kind) {
            case 'agent_message_chunk': {
                const content = update.content as { type: string; text?: string } | undefined;
                if (content?.type === 'text' && content.text) {
                    if (this.currentAssistantMessage) {
                        this.currentAssistantMessage.content += content.text;
                    }
                    this.postMessage({ type: 'appendAssistantText', text: content.text });
                }
                break;
            }
            case 'agent_thought_chunk': {
                const content = update.content as { type: string; text?: string } | undefined;
                if (content?.type === 'text' && content.text) {
                    this.postMessage({ type: 'appendThought', text: content.text });
                }
                break;
            }
            case 'tool_call': {
                const tc: ToolCallInfo = {
                    id: update.toolCallId as string,
                    name: (update.title as string) || (update.kind as string) || 'tool',
                    status: (update.status as ToolCallInfo['status']) || 'in_progress',
                    args: update.rawInput,
                };
                this.currentToolCalls.set(tc.id, tc);
                if (this.currentAssistantMessage) {
                    this.currentAssistantMessage.toolCalls?.push(tc);
                }
                this.postMessage({ type: 'toolCall', tool: tc });
                break;
            }
            case 'tool_call_update': {
                const id = update.toolCallId as string;
                const existing = this.currentToolCalls.get(id);
                if (existing) {
                    if (update.status) existing.status = update.status as ToolCallInfo['status'];
                    if (update.rawOutput !== undefined) {
                        existing.result = typeof update.rawOutput === 'string'
                            ? update.rawOutput
                            : JSON.stringify(update.rawOutput);
                        if (this.inferToolFailure(update.rawOutput)) {
                            existing.status = 'failed';
                        }
                    }
                    this.postMessage({ type: 'toolCallUpdate', tool: existing });
                }
                break;
            }
            case 'usage_update': {
                const usage = update.usage as UsageInfo | undefined;
                if (usage) this.postMessage({ type: 'usageUpdate', usage });
                break;
            }
        }
    }

    async newSession() {
        if (this.acp) {
            this.acp.stop();
            this.acp = null;
        }
        this.sessionId = null;
        this.messages = [];
        this.attachedFiles = [];
        this.context.workspaceState.update('hermes-chat.sessionId', null);
        this.postMessage({ type: 'clearMessages' });
        this.postMessage({ type: 'attachmentsChanged', files: [] });
        this.syncViewState();
    }

    clearChat() {
        this.messages = [];
        this.postMessage({ type: 'clearMessages' });
        this.syncViewState();
    }

    private buildQueryWithContext(text: string): string {
        const editor = vscode.window.activeTextEditor;
        const sections: string[] = [`[Workspace: ${this.getWorkspaceCwd()}]`];

        if (editor) {
            const filePath = vscode.workspace.asRelativePath(editor.document.uri);
            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);

            sections.push(`[File: ${filePath}]`);
            if (selectedText) {
                const lang = editor.document.languageId;
                sections.push(`[Selected code:]\n\`\`\`${lang}\n${selectedText}\n\`\`\``);
            }
        }

        if (this.attachedFiles.length) {
            for (const file of this.attachedFiles) {
                const ext = file.label.split('.').pop() || 'text';
                const truncationNote = file.truncated ? '\n[Note: truncated to fit context limit]' : '';
                sections.push(`[Attached file: ${file.label}]\n\`\`\`${ext}\n${file.content}\n\`\`\`${truncationNote}`);
            }
        }

        if (this.isHistoryRecallQuery(text)) {
            sections.push('[History recall instruction: If the user is asking about previous conversations or exact timing, use session_search before answering. Do not guess or claim the session database is unavailable unless a tool call actually failed and you state that concrete tool result.]');
        }

        sections.push(text);
        return sections.join('\n\n');
    }

    private postMessage(message: Record<string, unknown>) {
        const targets = [this.sidebarView?.webview, this.panel?.webview].filter((webview): webview is vscode.Webview => Boolean(webview));
        for (const target of targets) {
            void target.postMessage(message);
        }
    }

    async switchModel(modelId: string): Promise<void> {
        const client = await this.ensureAcp();
        await client.setModel(modelId, this.sessionId ?? undefined);
    }

    dispose() {
        this.acp?.stop();
    }

    private getHtml(mode: 'sidebar' | 'panel'): string {
        const nonce = getNonce();
        const initialState = JSON.stringify(this.getInitialWebviewState(mode)).replace(/</g, '\\u003c');
        return /*html*/ `<!DOCTYPE html>
<html lang="en" data-mode="${mode}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.sidebarView?.webview.cspSource || this.panel?.webview.cspSource} https: data:; style-src ${this.sidebarView?.webview.cspSource || this.panel?.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    display: flex;
    flex-direction: column;
    height: 100vh;
}

html[data-mode="panel"] body {
    background: var(--vscode-editor-background);
}

#shell {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
}

#topbar {
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #333));
    background: color-mix(in srgb, var(--vscode-sideBar-background) 92%, var(--vscode-editor-background) 8%);
}

.topbar-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.title-group {
    min-width: 0;
}

.title {
    font-size: 13px;
    font-weight: 600;
    color: var(--vscode-foreground);
}

.subtitle {
    margin-top: 2px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
}

.toolbar-btn {
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    white-space: nowrap;
}

.toolbar-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
}

#open-panel-btn {
    display: inline-flex;
}

html[data-mode="panel"] #open-panel-btn {
    display: none;
}

#status-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
}

.pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 999px;
    font-size: 11px;
    border: 1px solid var(--vscode-widget-border, #444);
    background: var(--vscode-badge-background, rgba(127,127,127,0.14));
    color: var(--vscode-badge-foreground, var(--vscode-foreground));
    min-width: 0;
}

.pill.toggleable {
    cursor: pointer;
    transition: border-color 120ms ease, background 120ms ease;
}

.pill.toggleable:hover {
    border-color: var(--vscode-focusBorder, var(--vscode-widget-border, #444));
}

.pill.toggleable:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: 1px;
}

.pill.active {
    border-color: var(--vscode-focusBorder, var(--vscode-widget-border, #444));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder, #007fd4) 35%, transparent);
}

.pill strong {
    font-weight: 600;
}

.pill.session-active {
    background: color-mix(in srgb, var(--vscode-testing-iconPassed, #388a34) 18%, transparent);
}

.pill.session-idle {
    background: color-mix(in srgb, var(--vscode-descriptionForeground) 12%, transparent);
}

.pill.context-selected {
    background: color-mix(in srgb, var(--vscode-progressBar-background, #0e639c) 18%, transparent);
}

.pill.ready {
    background: color-mix(in srgb, var(--vscode-testing-iconPassed, #388a34) 18%, transparent);
}

.pill.warning {
    background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 18%, transparent);
}

#status-diagnostics {
    display: none;
    margin-top: 8px;
    padding: 10px 12px;
    border: 1px solid var(--vscode-widget-border, #444);
    border-radius: 8px;
    background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-sideBar-background) 12%);
    font-size: 12px;
}

#status-diagnostics.visible {
    display: block;
}

#status-diagnostics.ready {
    border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #388a34) 45%, var(--vscode-widget-border, #444));
}

#status-diagnostics.warning {
    border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 45%, var(--vscode-widget-border, #444));
}

.diagnostics-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
}

.diagnostics-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-foreground);
}

.diagnostics-close {
    border: none;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0;
}

.diagnostics-close:hover {
    color: var(--vscode-foreground);
}

.diagnostics-summary {
    color: var(--vscode-descriptionForeground);
    line-height: 1.45;
}

.diagnostics-list {
    margin: 8px 0 0;
    padding-left: 18px;
    color: var(--vscode-foreground);
}

.diagnostics-list li + li {
    margin-top: 4px;
}

#messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

html[data-mode="panel"] #messages {
    padding: 18px 24px;
}

.message {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 100%;
}

.message-bubble {
    padding: 10px 12px;
    border-radius: 8px;
    max-width: 95%;
    overflow-wrap: anywhere;
    line-height: 1.5;
}

html[data-mode="panel"] .message-bubble {
    max-width: min(1100px, 100%);
}

.message.user {
    align-self: flex-end;
    align-items: flex-end;
}

.message.user .message-bubble {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-bottom-right-radius: 2px;
}

html[data-mode="panel"] .message.user .message-bubble {
    max-width: min(900px, 82%);
}

.message.assistant {
    align-self: flex-start;
    width: 100%;
}

.message.assistant .message-bubble {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #333));
    border-bottom-left-radius: 2px;
    width: 100%;
}

.message-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}

.message-meta .role {
    font-weight: 600;
    color: var(--vscode-foreground);
}

.message.assistant pre {
    background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
    padding: 8px;
    border-radius: 4px;
    overflow-x: auto;
    margin: 8px 0;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
}

.message.assistant code {
    font-family: var(--vscode-editor-font-family);
    background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
    padding: 1px 4px;
    border-radius: 3px;
}

.message.assistant pre code { background: none; padding: 0; }
.message.assistant p { margin: 6px 0; }
.message.assistant ul, .message.assistant ol { padding-left: 20px; margin: 4px 0; }
.message.assistant h1, .message.assistant h2, .message.assistant h3 { margin: 8px 0 4px; }
.message.assistant li + li { margin-top: 3px; }

.assistant-stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.thought {
    border-left: 3px solid var(--vscode-textBlockQuote-border, #555);
    padding: 6px 10px;
    background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.08));
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}

.thought-label {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 10px;
    margin-bottom: 4px;
}

.tool-call {
    background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1));
    border: 1px solid var(--vscode-widget-border, #444);
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 12px;
}

.tool-call .tool-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-weight: 500;
}

.tool-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tool-call .tool-status {
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 999px;
    text-transform: capitalize;
}

.tool-status.in_progress {
    background: var(--vscode-progressBar-background, #0e639c);
    color: white;
}

.tool-status.completed {
    background: var(--vscode-testing-iconPassed, #388a34);
    color: white;
}

.tool-status.failed {
    background: var(--vscode-errorForeground, #f48771);
    color: white;
}

.tool-call details {
    margin-top: 6px;
}

.tool-call summary {
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
}

.tool-call pre {
    margin-top: 4px;
    font-size: 11px;
    max-height: 220px;
    overflow-y: auto;
}

.usage-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 8px;
    margin-top: 2px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    border-top: 1px solid var(--vscode-widget-border, #333);
}

.usage-chip {
    padding: 3px 7px;
    border-radius: 999px;
    background: var(--vscode-badge-background, rgba(127,127,127,0.14));
    color: var(--vscode-badge-foreground, var(--vscode-foreground));
}

.error {
    color: var(--vscode-errorForeground);
    background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1));
    border: 1px solid var(--vscode-inputValidation-errorBorder, #f44);
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 12px;
}

#loading {
    display: none;
    padding: 0 12px 10px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
}

#loading.visible { display: block; }

.dots::after {
    content: '';
    animation: dots 1.5s steps(4, end) infinite;
}

@keyframes dots {
    0% { content: ''; }
    25% { content: '.'; }
    50% { content: '..'; }
    75% { content: '...'; }
}

#welcome {
    padding: 18px 14px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #333));
    border-radius: 8px;
    background: var(--vscode-editor-background);
    color: var(--vscode-descriptionForeground);
}

#welcome h2 { margin-bottom: 6px; color: var(--vscode-foreground); font-size: 15px; }
#welcome p { line-height: 1.5; }
#welcome-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
}

#attachment-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

#workspace-browser {
    display: none;
    border: 1px solid var(--vscode-widget-border, #444);
    border-radius: 8px;
    background: var(--vscode-editor-background);
    padding: 8px;
    max-height: 280px;
    overflow: auto;
}

#workspace-browser.visible {
    display: block;
}

#workspace-browser-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}

#workspace-tree-empty {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 4px 2px;
}

.tree-folder,
.tree-file {
    margin-left: 12px;
}

.tree-root {
    margin-left: 0;
}

.tree-folder summary {
    list-style: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    padding: 3px 0;
    color: var(--vscode-foreground);
}

.tree-folder summary::-webkit-details-marker {
    display: none;
}

.folder-chevron {
    display: inline-block;
    width: 10px;
    color: var(--vscode-descriptionForeground);
}

.tree-folder[open] > summary .folder-chevron {
    transform: rotate(90deg);
}

.tree-children {
    margin-left: 10px;
    padding-left: 8px;
    border-left: 1px solid color-mix(in srgb, var(--vscode-widget-border, #444) 70%, transparent);
}

.tree-file {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 0;
    font-size: 12px;
}

.tree-file input[type="checkbox"] {
    margin: 0;
}

.tree-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

#attachments {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}

.attachment-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    padding: 4px 8px;
    border-radius: 999px;
    border: 1px solid var(--vscode-widget-border, #444);
    background: var(--vscode-badge-background, rgba(127,127,127,0.14));
    font-size: 11px;
    color: var(--vscode-foreground);
}

.attachment-chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 220px;
}

html[data-mode="panel"] .attachment-chip-label {
    max-width: 320px;
}

.attachment-chip button {
    border: none;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
}

.attachment-chip button:hover {
    color: var(--vscode-foreground);
}

#input-area {
    padding: 10px 12px 12px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #333));
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 90%, var(--vscode-editor-background) 10%);
}

html[data-mode="panel"] #input-area {
    padding: 14px 24px 18px;
}

#composer-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}

#context-badge {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

#composer {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    width: 100%;
}

html[data-mode="panel"] #composer {
    max-width: 1100px;
}

#input {
    flex: 1;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    padding: 6px 8px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    resize: none;
    min-height: 36px;
    max-height: 180px;
    outline: none;
}

#input:focus { border-color: var(--vscode-focusBorder); }

#send-btn, #cancel-btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 13px;
    height: 36px;
}

#send-btn:hover, #cancel-btn:hover {
    background: var(--vscode-button-hoverBackground);
}

#send-btn:disabled {
    cursor: default;
    opacity: 0.6;
}

#cancel-btn { display: none; background: var(--vscode-errorForeground, #f48771); }
#cancel-btn.visible { display: inline-block; }

#composer-hint {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
}

#jump-latest {
    position: fixed;
    right: 12px;
    bottom: 86px;
    display: none;
    border: 1px solid var(--vscode-widget-border, #444);
    border-radius: 999px;
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    padding: 6px 10px;
    font-size: 11px;
    cursor: pointer;
}

#jump-latest.visible {
    display: inline-flex;
}
</style>
</head>
<body>
    <div id="shell">
        <div id="topbar">
            <div class="topbar-row">
                <div class="title-group">
                    <div class="title">Hermes Agent</div>
                    <div class="subtitle">ACP chat, tools, memory, models, and workspace context</div>
                </div>
                <div class="topbar-row">
                    <button id="open-panel-btn" class="toolbar-btn" type="button">Open wide</button>
                </div>
            </div>
        </div>

        <div id="messages">
            <div id="welcome">
                <h2>Start a Hermes session</h2>
                <p>Ask about the active file, selected code, or anything in your local Hermes setup. Tool calls and token usage stream in place.</p>
            </div>
        </div>

        <div id="loading"><span class="dots">Hermes is thinking</span></div>
        <div id="input-area">
            <div id="composer-meta">
                <div id="context-badge">No active editor</div>
                <div id="composer-hint">Enter to send, Shift+Enter for a new line</div>
            </div>
            <div id="attachment-toolbar">
                <button id="attach-files-btn" class="toolbar-btn" type="button">Browse workspace</button>
                <button id="clear-attachments-btn" class="toolbar-btn" type="button">Clear attached</button>
                <div id="attachments"></div>
            </div>
            <div id="workspace-browser">
                <div id="workspace-browser-header">
                    <span>Attach files from the current workspace</span>
                    <span id="workspace-browser-count"></span>
                </div>
                <div id="workspace-tree-empty">Loading workspace files...</div>
                <div id="workspace-tree"></div>
            </div>
            <div id="composer">
                <textarea id="input" rows="1" placeholder="Message Hermes..." autofocus></textarea>
                <button id="send-btn">Send</button>
                <button id="cancel-btn">Stop</button>
            </div>
        </div>
    </div>
    <button id="jump-latest" type="button">Jump to latest</button>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const initialData = ${initialState};
const messagesEl = document.getElementById('messages');
const welcomeEl = document.getElementById('welcome');
const loadingEl = document.getElementById('loading');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const cancelBtn = document.getElementById('cancel-btn');
const jumpLatestBtn = document.getElementById('jump-latest');
const contextBadge = document.getElementById('context-badge');
const openPanelBtn = document.getElementById('open-panel-btn');
const attachFilesBtn = document.getElementById('attach-files-btn');
const clearAttachmentsBtn = document.getElementById('clear-attachments-btn');
const attachmentsEl = document.getElementById('attachments');
const workspaceBrowserEl = document.getElementById('workspace-browser');
const workspaceTreeEl = document.getElementById('workspace-tree');
const workspaceTreeEmptyEl = document.getElementById('workspace-tree-empty');
const workspaceBrowserCountEl = document.getElementById('workspace-browser-count');

const state = vscode.getState() || { draft: '' };
inputEl.value = state.draft || '';

let currentAssistantEl = null;
let currentTextEl = null;
let currentToolsEl = null;
let toolEls = new Map();
let shouldStickToBottom = true;
let workspaceTree = [];
let attachedFilePaths = new Set();

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatInline(text) {
    return text
        .replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>')
        .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*([^*\\n]+)\\*/g, '<em>$1</em>');
}

function renderMarkdown(text) {
    const codeBlocks = [];
    let escaped = escapeHtml(text).replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
        const idx = codeBlocks.length;
        const langLabel = lang ? '<div class="subtitle">' + escapeHtml(lang) + '</div>' : '';
        codeBlocks.push(langLabel + '<pre><code>' + code + '</code></pre>');
        return '\\n@@CODEBLOCK_' + idx + '@@\\n';
    });

    const blocks = escaped.split(/\\n{2,}/).map((block) => block.trim()).filter(Boolean);
    const rendered = blocks.map((block) => {
        if (/^@@CODEBLOCK_\\d+@@$/.test(block)) return block;

        const heading = block.match(/^(#{1,3})\\s+(.+)$/);
        if (heading) {
            const level = heading[1].length;
            return '<h' + level + '>' + formatInline(heading[2]) + '</h' + level + '>';
        }

        const lines = block.split('\\n');
        if (lines.every((line) => /^[-*]\\s+/.test(line))) {
            return '<ul>' + lines.map((line) => '<li>' + formatInline(line.replace(/^[-*]\\s+/, '')) + '</li>').join('') + '</ul>';
        }
        if (lines.every((line) => /^\\d+\\.\\s+/.test(line))) {
            return '<ol>' + lines.map((line) => '<li>' + formatInline(line.replace(/^\\d+\\.\\s+/, '')) + '</li>').join('') + '</ol>';
        }

        return '<p>' + formatInline(block).replace(/\\n/g, '<br>') + '</p>';
    }).join('');

    return rendered.replace(/@@CODEBLOCK_(\\d+)@@/g, (_, idx) => codeBlocks[Number(idx)] || '');
}

function updateDraft() {
    vscode.setState({ ...state, draft: inputEl.value });
}

function maybeAutoScroll() {
    if (shouldStickToBottom) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    jumpLatestBtn.classList.toggle('visible', !shouldStickToBottom);
}

function updateScrollStickiness() {
    const distanceFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    shouldStickToBottom = distanceFromBottom < 48;
    jumpLatestBtn.classList.toggle('visible', !shouldStickToBottom);
}

function createMessageShell(role, timestamp) {
    const wrapper = document.createElement('div');
    wrapper.className = 'message ' + role;

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.innerHTML = '<span class="role">' + (role === 'user' ? 'You' : 'Hermes') + '</span><span>' + formatTime(timestamp) + '</span>';
    wrapper.appendChild(meta);

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    wrapper.appendChild(bubble);

    return { wrapper, bubble };
}

function syncSessionState(msg) {
    const info = msg.contextInfo || {};
    const detail = info.detail ? ' · ' + info.detail : '';
    contextBadge.textContent = (info.fileLabel || 'No active editor') + detail;
    renderAttachments(msg.attachedFiles || []);
}

function updateWorkspaceTreeMeta() {
    workspaceBrowserCountEl.textContent = attachedFilePaths.size
        ? attachedFilePaths.size + ' attached'
        : 'No files attached';
}

function createTreeNode(node, depth = 0) {
    if (node.kind === 'folder') {
        const details = document.createElement('details');
        details.className = 'tree-folder' + (depth === 0 ? ' tree-root' : '');
        details.open = depth < 2;
        const summary = document.createElement('summary');
        summary.innerHTML = '<span class="folder-chevron">▶</span><span class="tree-label">' + escapeHtml(node.label) + '</span>';
        details.appendChild(summary);

        const children = document.createElement('div');
        children.className = 'tree-children';
        (node.children || []).forEach((child) => children.appendChild(createTreeNode(child, depth + 1)));
        details.appendChild(children);
        return details;
    }

    const row = document.createElement('label');
    row.className = 'tree-file';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = attachedFilePaths.has(node.path);
    checkbox.addEventListener('change', () => {
        if (checkbox.checked && attachedFilePaths.size >= ${HermesChatViewProvider.maxAttachedFiles} && !attachedFilePaths.has(node.path)) {
            checkbox.checked = false;
            return;
        }
        vscode.postMessage({ type: 'toggleAttachment', path: node.path, checked: checkbox.checked });
    });
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = node.label;
    row.appendChild(checkbox);
    row.appendChild(label);
    return row;
}

function renderWorkspaceTree(tree) {
    workspaceTree = Array.isArray(tree) ? tree : [];
    workspaceTreeEl.innerHTML = '';
    if (!workspaceTree.length) {
        workspaceTreeEmptyEl.style.display = 'block';
        workspaceTreeEmptyEl.textContent = 'No workspace files found.';
        updateWorkspaceTreeMeta();
        return;
    }

    workspaceTreeEmptyEl.style.display = 'none';
    workspaceTree.forEach((node) => workspaceTreeEl.appendChild(createTreeNode(node)));
    updateWorkspaceTreeMeta();
}

function renderAttachments(files) {
    attachedFilePaths = new Set((files || []).map((file) => file.path));
    attachmentsEl.innerHTML = '';
    clearAttachmentsBtn.style.display = files.length ? 'inline-flex' : 'none';
    files.forEach((file) => {
        const chip = document.createElement('div');
        chip.className = 'attachment-chip';
        chip.innerHTML = '<span class="attachment-chip-label">' + escapeHtml(file.label) + (file.truncated ? ' (truncated)' : '') + '</span>';
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = 'x';
        removeBtn.title = 'Remove attachment';
        removeBtn.addEventListener('click', () => vscode.postMessage({ type: 'removeAttachment', path: file.path }));
        chip.appendChild(removeBtn);
        attachmentsEl.appendChild(chip);
    });
    if (workspaceTree.length) renderWorkspaceTree(workspaceTree);
    else updateWorkspaceTreeMeta();
}

function hydrateFromInitialState(data) {
    syncSessionState(data);
    renderWorkspaceTree(data.workspaceTree || []);
    if (Array.isArray(data.messages)) {
        data.messages.forEach(addMessageToUI);
    }
    if (data.currentAssistantMessage) {
        startAssistantMessage(data.currentAssistantMessage.timestamp || Date.now());
        if (Array.isArray(data.currentAssistantMessage.toolCalls)) {
            data.currentAssistantMessage.toolCalls.forEach(renderTool);
        }
        if (data.currentAssistantMessage.content) {
            appendAssistantText(data.currentAssistantMessage.content);
        }
    }
    if (data.isProcessing) {
        loadingEl.classList.add('visible');
        sendBtn.style.display = 'none';
        cancelBtn.classList.add('visible');
        inputEl.disabled = true;
    }
}

function addMessageToUI(message) {
    if (welcomeEl) welcomeEl.style.display = 'none';
    const shell = createMessageShell(message.role, message.timestamp || Date.now());
    if (message.role === 'user') {
        shell.bubble.textContent = message.content;
    } else {
        shell.bubble.innerHTML = renderMarkdown(message.content);
    }
    messagesEl.appendChild(shell.wrapper);
    maybeAutoScroll();
}

function startAssistantMessage(timestamp) {
    if (welcomeEl) welcomeEl.style.display = 'none';
    const shell = createMessageShell('assistant', timestamp || Date.now());
    currentAssistantEl = shell.wrapper;

    const stack = document.createElement('div');
    stack.className = 'assistant-stack';
    shell.bubble.appendChild(stack);

    currentToolsEl = document.createElement('div');
    currentToolsEl.className = 'tools-container';
    stack.appendChild(currentToolsEl);

    currentTextEl = document.createElement('div');
    currentTextEl.className = 'text-content';
    currentTextEl.dataset.raw = '';
    stack.appendChild(currentTextEl);

    messagesEl.appendChild(currentAssistantEl);
    toolEls = new Map();
    maybeAutoScroll();
}

function appendAssistantText(text) {
    if (!currentTextEl) startAssistantMessage(Date.now());
    const raw = (currentTextEl.dataset.raw || '') + text;
    currentTextEl.dataset.raw = raw;
    currentTextEl.innerHTML = renderMarkdown(raw);
    maybeAutoScroll();
}

function appendThought(text) {
    if (!currentAssistantEl) startAssistantMessage(Date.now());
    let thoughtEl = currentAssistantEl.querySelector('.thought-current');
    if (!thoughtEl) {
        thoughtEl = document.createElement('div');
        thoughtEl.className = 'thought thought-current';
        thoughtEl.innerHTML = '<div class="thought-label">Reasoning</div><div class="thought-body"></div>';
        const stack = currentAssistantEl.querySelector('.assistant-stack');
        if (stack) {
            stack.insertBefore(thoughtEl, currentToolsEl && currentToolsEl.childElementCount > 0 ? currentToolsEl.nextSibling : currentTextEl);
        }
    }
    const body = thoughtEl.querySelector('.thought-body');
    body.textContent += text;
    maybeAutoScroll();
}

function renderTool(tool) {
    const existing = toolEls.get(tool.id);
    const status = ['pending', 'in_progress', 'completed', 'failed'].includes(tool.status) ? tool.status : 'pending';
    const inputText = tool.args ? escapeHtml(typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args, null, 2)) : '';
    const outputText = tool.result ? escapeHtml(tool.result) : '';
    const html = \`
        <div class="tool-header">
            <span class="tool-name">🔧 \${escapeHtml(tool.name)}</span>
            <span class="tool-status \${status}">\${status}</span>
        </div>
        \${inputText ? \`<details><summary>Input</summary><pre>\${inputText}</pre></details>\` : ''}
        \${outputText ? \`<details \${status === 'failed' ? 'open' : ''}><summary>Output</summary><pre>\${outputText}</pre></details>\` : ''}
    \`;
    if (existing) {
        existing.innerHTML = html;
    } else {
        if (!currentToolsEl) startAssistantMessage(Date.now());
        const div = document.createElement('div');
        div.className = 'tool-call';
        div.innerHTML = html;
        currentToolsEl.appendChild(div);
        toolEls.set(tool.id, div);
    }
    maybeAutoScroll();
}

function finalizeAssistantMessage(usage) {
    if (!currentAssistantEl) return;
    const thoughtEl = currentAssistantEl.querySelector('.thought-current');
    if (thoughtEl) thoughtEl.classList.remove('thought-current');
    if (usage) {
        const bar = document.createElement('div');
        bar.className = 'usage-bar';
        const parts = [];
        if (usage.inputTokens != null) parts.push(\`<span class="usage-chip">in \${usage.inputTokens.toLocaleString()}</span>\`);
        if (usage.outputTokens != null) parts.push(\`<span class="usage-chip">out \${usage.outputTokens.toLocaleString()}</span>\`);
        if (usage.totalTokens != null) parts.push(\`<span class="usage-chip">total \${usage.totalTokens.toLocaleString()}</span>\`);
        if (usage.cachedReadTokens) parts.push(\`<span class="usage-chip">cached \${usage.cachedReadTokens.toLocaleString()}</span>\`);
        bar.innerHTML = parts.join('');
        const bubble = currentAssistantEl.querySelector('.message-bubble');
        if (bubble) bubble.appendChild(bar);
    }
    currentAssistantEl = null;
    currentTextEl = null;
    currentToolsEl = null;
}

function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    updateDraft();
    sendBtn.disabled = true;
    vscode.postMessage({ type: 'sendMessage', text });
}

inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
    sendBtn.disabled = !inputEl.value.trim();
    updateDraft();
});

sendBtn.addEventListener('click', sendMessage);
cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
openPanelBtn?.addEventListener('click', () => vscode.postMessage({ type: 'openPanel' }));
attachFilesBtn?.addEventListener('click', () => {
    workspaceBrowserEl.classList.toggle('visible');
});
clearAttachmentsBtn?.addEventListener('click', () => vscode.postMessage({ type: 'clearAttachments' }));
jumpLatestBtn.addEventListener('click', () => {
    shouldStickToBottom = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    jumpLatestBtn.classList.remove('visible');
});
messagesEl.addEventListener('scroll', updateScrollStickiness);
sendBtn.disabled = !inputEl.value.trim();
inputEl.dispatchEvent(new Event('input'));
hydrateFromInitialState(initialData);

window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
        case 'addMessage': addMessageToUI(msg.message); break;
        case 'startAssistantMessage': startAssistantMessage(msg.timestamp); break;
        case 'appendAssistantText': appendAssistantText(msg.text); break;
        case 'appendThought': appendThought(msg.text); break;
        case 'toolCall': renderTool(msg.tool); break;
        case 'toolCallUpdate': renderTool(msg.tool); break;
        case 'finalizeAssistantMessage': finalizeAssistantMessage(msg.usage); break;
        case 'stateSync': syncSessionState(msg); break;
        case 'attachmentsChanged': renderAttachments(msg.files || []); break;
        case 'workspaceTree': renderWorkspaceTree(msg.tree || []); break;
        case 'clearMessages':
            messagesEl.innerHTML = '';
            if (welcomeEl) {
                messagesEl.appendChild(welcomeEl);
                welcomeEl.style.display = 'block';
            }
            currentAssistantEl = null;
            currentTextEl = null;
            currentToolsEl = null;
            toolEls = new Map();
            shouldStickToBottom = true;
            break;
        case 'setLoading':
            loadingEl.classList.toggle('visible', msg.loading);
            sendBtn.style.display = msg.loading ? 'none' : 'inline-block';
            cancelBtn.classList.toggle('visible', msg.loading);
            inputEl.disabled = msg.loading;
            if (!msg.loading) {
                inputEl.focus();
                sendBtn.disabled = !inputEl.value.trim();
            }
            if (msg.loading) maybeAutoScroll();
            break;
        case 'showError':
            const errDiv = document.createElement('div');
            errDiv.className = 'error';
            errDiv.textContent = msg.error;
            messagesEl.appendChild(errDiv);
            maybeAutoScroll();
            break;
    }
});
</script>
</body>
</html>`;
    }
}

function getNonce(): string {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
