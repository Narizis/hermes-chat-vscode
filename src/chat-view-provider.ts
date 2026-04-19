import * as vscode from 'vscode';
import { AcpClient, SessionUpdate } from './acp-client';
import { ChatMessage, ToolCallInfo, UsageInfo } from './types';
import { UsageStore } from './usage-store';

export class HermesChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'hermes-chat.chatView';

    private view?: vscode.WebviewView;
    private messages: ChatMessage[] = [];
    private sessionId: string | null = null;
    private isProcessing = false;
    private acp: AcpClient | null = null;
    private context: vscode.ExtensionContext;
    private currentAssistantMessage: ChatMessage | null = null;
    private currentToolCalls = new Map<string, ToolCallInfo>();
    private usageStore = new UsageStore();

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.sessionId = context.workspaceState.get('hermes-chat.sessionId', null);
    }

    private getHermesPath(): string {
        return vscode.workspace.getConfiguration('hermes-chat').get('hermesPath', 'hermes');
    }

    private async ensureAcp(): Promise<AcpClient> {
        if (this.acp && this.acp.isReady()) return this.acp;

        if (this.acp) this.acp.stop();

        const client = new AcpClient(this.getHermesPath());
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
                this.sessionId = await client.newSession(cwd);
                this.context.workspaceState.update('hermes-chat.sessionId', this.sessionId);
            }
        } else {
            this.sessionId = await client.newSession(cwd);
            this.context.workspaceState.update('hermes-chat.sessionId', this.sessionId);
        }

        this.acp = client;
        return client;
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

        webviewView.webview.onDidReceiveMessage(async (message) => {
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
            }
        });
    }

    async handleUserMessage(text: string) {
        if (this.isProcessing || !text.trim()) return;

        const query = this.buildQueryWithContext(text);
        const userMessage: ChatMessage = { role: 'user', content: text, timestamp: Date.now() };
        this.messages.push(userMessage);
        this.postMessage({ type: 'addMessage', message: userMessage });

        this.isProcessing = true;
        this.postMessage({ type: 'setLoading', loading: true });

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
                this.messages.push(this.currentAssistantMessage);
                this.postMessage({ type: 'finalizeAssistantMessage', usage: result.usage });
                if (result.usage) this.usageStore.record(result.usage);
            }
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            this.postMessage({ type: 'showError', error: errorMsg });
        } finally {
            this.isProcessing = false;
            this.currentAssistantMessage = null;
            this.postMessage({ type: 'setLoading', loading: false });
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
        this.context.workspaceState.update('hermes-chat.sessionId', null);
        this.postMessage({ type: 'clearMessages' });
    }

    clearChat() {
        this.messages = [];
        this.postMessage({ type: 'clearMessages' });
    }

    private buildQueryWithContext(text: string): string {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return text;

        const filePath = vscode.workspace.asRelativePath(editor.document.uri);
        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);

        if (!selectedText) return `[File: ${filePath}]\n\n${text}`;

        const lang = editor.document.languageId;
        return `[File: ${filePath}]\n[Selected code:]\n\`\`\`${lang}\n${selectedText}\n\`\`\`\n\n${text}`;
    }

    private postMessage(message: Record<string, unknown>) {
        this.view?.webview.postMessage(message);
    }

    async switchModel(modelId: string): Promise<void> {
        const client = await this.ensureAcp();
        await client.setModel(modelId, this.sessionId ?? undefined);
    }

    dispose() {
        this.acp?.stop();
    }

    private getHtml(): string {
        return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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

#messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.message {
    padding: 8px 12px;
    border-radius: 8px;
    max-width: 95%;
    word-wrap: break-word;
    line-height: 1.5;
}

.message.user {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    align-self: flex-end;
    border-bottom-right-radius: 2px;
}

.message.assistant {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #333));
    align-self: flex-start;
    border-bottom-left-radius: 2px;
    width: 100%;
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
.message.assistant p { margin: 4px 0; }
.message.assistant ul, .message.assistant ol { padding-left: 20px; margin: 4px 0; }
.message.assistant h1, .message.assistant h2, .message.assistant h3 { margin: 8px 0 4px; }

.thought {
    font-style: italic;
    opacity: 0.7;
    border-left: 3px solid var(--vscode-textBlockQuote-border, #555);
    padding: 4px 8px;
    margin: 4px 0;
    font-size: 0.9em;
}

.tool-call {
    background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1));
    border: 1px solid var(--vscode-widget-border, #444);
    border-radius: 4px;
    padding: 6px 8px;
    margin: 6px 0;
    font-size: 0.9em;
}

.tool-call .tool-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 500;
}

.tool-call .tool-status {
    font-size: 0.85em;
    padding: 1px 6px;
    border-radius: 3px;
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
    margin-top: 4px;
}

.tool-call summary {
    cursor: pointer;
    opacity: 0.7;
    font-size: 0.85em;
}

.tool-call pre {
    margin-top: 4px;
    font-size: 0.8em;
    max-height: 200px;
    overflow-y: auto;
}

.usage-bar {
    display: flex;
    gap: 12px;
    padding: 4px 8px;
    margin-top: 6px;
    font-size: 0.8em;
    opacity: 0.7;
    border-top: 1px solid var(--vscode-widget-border, #333);
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
    padding: 8px 12px;
    align-self: flex-start;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
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
    padding: 24px 16px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
}

#welcome h2 { margin-bottom: 8px; color: var(--vscode-foreground); }

#input-area {
    padding: 8px 12px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #333));
    display: flex;
    gap: 6px;
    align-items: flex-end;
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
    max-height: 120px;
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

#cancel-btn { display: none; background: var(--vscode-errorForeground, #f48771); }
#cancel-btn.visible { display: inline-block; }
</style>
</head>
<body>
    <div id="messages">
        <div id="welcome">
            <h2>Hermes Agent</h2>
            <p>Streaming chat with tools, memory, and full agent capabilities.</p>
        </div>
    </div>
    <div id="loading"><span class="dots">Hermes is thinking</span></div>
    <div id="input-area">
        <textarea id="input" rows="1" placeholder="Message Hermes..." autofocus></textarea>
        <button id="send-btn">Send</button>
        <button id="cancel-btn">Stop</button>
    </div>

<script>
const vscode = acquireVsCodeApi();
const messagesEl = document.getElementById('messages');
const welcomeEl = document.getElementById('welcome');
const loadingEl = document.getElementById('loading');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const cancelBtn = document.getElementById('cancel-btn');

let currentAssistantEl = null;
let currentTextEl = null;
let currentToolsEl = null;
let toolEls = new Map();

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function renderMarkdown(text) {
    let html = escapeHtml(text);
    html = html.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>');
    html = html.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
    html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    html = html.replace(/\\*([^*\\n]+)\\*/g, '<em>$1</em>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/^[\\-\\*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/\\n\\n/g, '</p><p>');
    html = '<p>' + html + '</p>';
    html = html.replace(/([^>])\\n([^<])/g, '$1<br>$2');
    html = html.replace(/<p><\\/p>/g, '');
    return html;
}

function addMessageToUI(message) {
    if (welcomeEl) welcomeEl.style.display = 'none';
    const div = document.createElement('div');
    div.className = 'message ' + message.role;
    if (message.role === 'user') {
        div.textContent = message.content;
    } else {
        div.innerHTML = renderMarkdown(message.content);
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function startAssistantMessage() {
    if (welcomeEl) welcomeEl.style.display = 'none';
    currentAssistantEl = document.createElement('div');
    currentAssistantEl.className = 'message assistant';

    currentToolsEl = document.createElement('div');
    currentToolsEl.className = 'tools-container';
    currentAssistantEl.appendChild(currentToolsEl);

    currentTextEl = document.createElement('div');
    currentTextEl.className = 'text-content';
    currentTextEl.dataset.raw = '';
    currentAssistantEl.appendChild(currentTextEl);

    messagesEl.appendChild(currentAssistantEl);
    toolEls = new Map();
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendAssistantText(text) {
    if (!currentTextEl) startAssistantMessage();
    const raw = (currentTextEl.dataset.raw || '') + text;
    currentTextEl.dataset.raw = raw;
    currentTextEl.innerHTML = renderMarkdown(raw);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendThought(text) {
    if (!currentAssistantEl) startAssistantMessage();
    let thoughtEl = currentAssistantEl.querySelector('.thought-current');
    if (!thoughtEl) {
        thoughtEl = document.createElement('div');
        thoughtEl.className = 'thought thought-current';
        currentAssistantEl.insertBefore(thoughtEl, currentTextEl);
    }
    thoughtEl.textContent += text;
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderTool(tool) {
    const existing = toolEls.get(tool.id);
    const html = \`
        <div class="tool-header">
            <span>🔧 \${escapeHtml(tool.name)}</span>
            <span class="tool-status \${tool.status}">\${tool.status}</span>
        </div>
        \${tool.args ? \`<details><summary>input</summary><pre>\${escapeHtml(typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args, null, 2))}</pre></details>\` : ''}
        \${tool.result ? \`<details><summary>output</summary><pre>\${escapeHtml(tool.result)}</pre></details>\` : ''}
    \`;
    if (existing) {
        existing.innerHTML = html;
    } else {
        if (!currentToolsEl) startAssistantMessage();
        const div = document.createElement('div');
        div.className = 'tool-call';
        div.innerHTML = html;
        currentToolsEl.appendChild(div);
        toolEls.set(tool.id, div);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function finalizeAssistantMessage(usage) {
    if (!currentAssistantEl) return;
    const thoughtEl = currentAssistantEl.querySelector('.thought-current');
    if (thoughtEl) thoughtEl.classList.remove('thought-current');
    if (usage) {
        const bar = document.createElement('div');
        bar.className = 'usage-bar';
        const parts = [];
        if (usage.inputTokens != null) parts.push(\`in: \${usage.inputTokens.toLocaleString()}\`);
        if (usage.outputTokens != null) parts.push(\`out: \${usage.outputTokens.toLocaleString()}\`);
        if (usage.totalTokens != null) parts.push(\`total: \${usage.totalTokens.toLocaleString()}\`);
        if (usage.cachedReadTokens) parts.push(\`cached: \${usage.cachedReadTokens.toLocaleString()}\`);
        bar.textContent = parts.join(' · ');
        currentAssistantEl.appendChild(bar);
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
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});

sendBtn.addEventListener('click', sendMessage);
cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
        case 'addMessage': addMessageToUI(msg.message); break;
        case 'startAssistantMessage': startAssistantMessage(); break;
        case 'appendAssistantText': appendAssistantText(msg.text); break;
        case 'appendThought': appendThought(msg.text); break;
        case 'toolCall': renderTool(msg.tool); break;
        case 'toolCallUpdate': renderTool(msg.tool); break;
        case 'finalizeAssistantMessage': finalizeAssistantMessage(msg.usage); break;
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
            break;
        case 'setLoading':
            loadingEl.classList.toggle('visible', msg.loading);
            sendBtn.style.display = msg.loading ? 'none' : 'inline-block';
            cancelBtn.classList.toggle('visible', msg.loading);
            inputEl.disabled = msg.loading;
            if (!msg.loading) inputEl.focus();
            if (msg.loading) messagesEl.scrollTop = messagesEl.scrollHeight;
            break;
        case 'showError':
            const errDiv = document.createElement('div');
            errDiv.className = 'error';
            errDiv.textContent = msg.error;
            messagesEl.appendChild(errDiv);
            messagesEl.scrollTop = messagesEl.scrollHeight;
            break;
    }
});
</script>
</body>
</html>`;
    }
}
