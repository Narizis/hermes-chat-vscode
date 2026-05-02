import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import * as path from 'path';
import { UsageInfo } from './types';

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: unknown;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: unknown;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export interface SessionUpdate {
    sessionId: string;
    update: {
        sessionUpdate: string;
        [key: string]: unknown;
    };
}

export interface ToolCall {
    toolCallId: string;
    title?: string;
    kind?: string;
    status?: 'pending' | 'in_progress' | 'completed' | 'failed';
    rawInput?: unknown;
    rawOutput?: unknown;
}

export class AcpClient extends EventEmitter {
    private proc: ChildProcess | null = null;
    private nextId = 1;
    private pendingRequests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: NodeJS.Timeout }>();
    private buffer = '';
    private initialized = false;
    private sessionId: string | null = null;
    private hermesPath: string;
    private requestTimeoutMs: number;
    private stopping = false;

    constructor(hermesPath: string, requestTimeoutMs = 180_000) {
        super();
        this.hermesPath = hermesPath;
        this.requestTimeoutMs = requestTimeoutMs;
    }

    private getWorkspaceRoots(): string[] {
        return (vscode.workspace.workspaceFolders || []).map((folder) => path.resolve(folder.uri.fsPath));
    }

    private assertWorkspacePath(targetPath: string): void {
        const roots = this.getWorkspaceRoots();
        if (!roots.length) {
            throw new Error('Workspace file access is unavailable because no folder is open in VS Code.');
        }

        const normalizedTarget = path.resolve(targetPath);
        const isAllowed = roots.some((root) => {
            const relative = path.relative(root, normalizedTarget);
            return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
        });

        if (!isAllowed) {
            throw new Error(`Blocked file access outside the current workspace: ${targetPath}`);
        }
    }

    async start(): Promise<void> {
        if (this.proc) return;

        this.stopping = false;

        this.proc = spawn(this.hermesPath, ['acp'], {
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.proc.stdout!.on('data', (data: Buffer) => {
            this.buffer += data.toString('utf8');
            this.processBuffer();
        });

        this.proc.stderr!.on('data', (data: Buffer) => {
            this.emit('log', data.toString('utf8'));
        });

        this.proc.on('exit', (code) => {
            if (!this.stopping) {
                this.emit('exit', code);
            }
            this.proc = null;
            this.initialized = false;
            for (const { reject, timeout } of this.pendingRequests.values()) {
                clearTimeout(timeout);
                reject(new Error(`Hermes ACP process exited with code ${code}`));
            }
            this.pendingRequests.clear();
        });

        this.proc.on('error', (err) => {
            this.emit('error', err);
        });

        await this.initialize();
    }

    private processBuffer(): void {
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line) continue;
            try {
                const msg = JSON.parse(line) as JsonRpcMessage;
                this.handleMessage(msg);
            } catch (e) {
                this.emit('log', `[parse error] ${line}\n`);
            }
        }
    }

    private handleMessage(msg: JsonRpcMessage): void {
        if ('id' in msg && msg.id !== undefined && ('result' in msg || 'error' in msg)) {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
                this.pendingRequests.delete(msg.id);
                clearTimeout(pending.timeout);
                if ('error' in msg && msg.error) {
                    pending.reject(new Error(msg.error.message));
                } else {
                    pending.resolve((msg as JsonRpcResponse).result);
                }
            }
            return;
        }

        if ('method' in msg) {
            // Notification or server-initiated request
            if ('id' in msg && msg.id !== undefined) {
                this.handleServerRequest(msg as JsonRpcRequest);
            } else {
                this.handleNotification(msg as JsonRpcNotification);
            }
        }
    }

    private handleServerRequest(req: JsonRpcRequest): void {
        const params = req.params as Record<string, unknown> | undefined;

        switch (req.method) {
            case 'session/request_permission': {
                this.emit('permissionRequest', params);
                this.handlePermissionRequest(req.id, params);
                break;
            }

            case 'fs/read_text_file': {
                this.handleReadFile(req.id, params);
                break;
            }

            case 'fs/write_text_file': {
                this.handleWriteFile(req.id, params);
                break;
            }

            default:
                this.sendError(req.id, -32601, `Method not found: ${req.method}`);
        }
    }

    private handleNotification(notif: JsonRpcNotification): void {
        const params = notif.params as Record<string, unknown> | undefined;

        switch (notif.method) {
            case 'session/update':
                if (params) {
                    this.emit('sessionUpdate', {
                        sessionId: params.sessionId as string,
                        update: params.update,
                    });
                }
                break;
        }
    }

    private async handlePermissionRequest(id: number, params: Record<string, unknown> | undefined): Promise<void> {
        // Auto-allow for now; user can be prompted in future
        const options = params?.options as Array<{ optionId: string; name: string; kind: string }> | undefined;
        const allowOnce = options?.find((o) => o.kind === 'allow_once');
        const allowAlways = options?.find((o) => o.kind === 'allow_always');
        const chosen = allowAlways || allowOnce || options?.[0];
        this.sendResponse(id, {
            outcome: { outcome: 'selected', optionId: chosen?.optionId ?? 'allow' },
        });
    }

    private async handleReadFile(id: number, params: Record<string, unknown> | undefined): Promise<void> {
        try {
            const path = params?.path as string;
            this.assertWorkspacePath(path);
            const content = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
            this.sendResponse(id, { content: Buffer.from(content).toString('utf8') });
        } catch (e) {
            this.sendError(id, -32000, e instanceof Error ? e.message : String(e));
        }
    }

    private async handleWriteFile(id: number, params: Record<string, unknown> | undefined): Promise<void> {
        try {
            const path = params?.path as string;
            const content = params?.content as string;
            this.assertWorkspacePath(path);
            await vscode.workspace.fs.writeFile(vscode.Uri.file(path), Buffer.from(content, 'utf8'));
            this.sendResponse(id, null);
        } catch (e) {
            this.sendError(id, -32000, e instanceof Error ? e.message : String(e));
        }
    }

    private send(msg: JsonRpcMessage): void {
        if (!this.proc || !this.proc.stdin) {
            throw new Error('ACP process not started');
        }
        this.proc.stdin.write(JSON.stringify(msg) + '\n');
    }

    private sendResponse(id: number, result: unknown): void {
        this.send({ jsonrpc: '2.0', id, result } as JsonRpcResponse);
    }

    private sendError(id: number, code: number, message: string): void {
        this.send({ jsonrpc: '2.0', id, error: { code, message } } as JsonRpcResponse);
    }

    private request<T = unknown>(method: string, params?: unknown): Promise<T> {
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Hermes ACP request timed out after ${Math.round(this.requestTimeoutMs / 1000)}s: ${method}`));
            }, this.requestTimeoutMs);

            this.pendingRequests.set(id, {
                resolve: resolve as (v: unknown) => void,
                reject,
                timeout,
            });

            try {
                this.send({ jsonrpc: '2.0', id, method, params });
            } catch (err) {
                clearTimeout(timeout);
                this.pendingRequests.delete(id);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    private async initialize(): Promise<void> {
        await this.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
                fs: { readTextFile: true, writeTextFile: true },
                terminal: false,
            },
            clientInfo: { name: 'hermes-chat-vscode', version: '0.2.0' },
        });
        this.initialized = true;
    }

    async newSession(cwd: string): Promise<string> {
        const result = await this.request<{ sessionId: string }>('session/new', {
            cwd,
            mcpServers: [],
        });
        this.sessionId = result.sessionId;
        return result.sessionId;
    }

    async resumeSession(sessionId: string, cwd: string): Promise<boolean> {
        try {
            await this.request('session/resume', { sessionId, cwd, mcpServers: [] });
            this.sessionId = sessionId;
            return true;
        } catch {
            return false;
        }
    }

    async prompt(text: string, sessionId?: string): Promise<{ stopReason: string; usage?: UsageInfo }> {
        const sid = sessionId ?? this.sessionId;
        if (!sid) throw new Error('No active session');
        const result = await this.request<{ stopReason: string; usage?: UsageInfo }>('session/prompt', {
            sessionId: sid,
            prompt: [{ type: 'text', text }],
        });
        return result;
    }

    async cancel(sessionId?: string): Promise<void> {
        const sid = sessionId ?? this.sessionId;
        if (!sid) return;
        // session/cancel is a notification (no response expected)
        this.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid } });
    }

    async setModel(modelId: string, sessionId?: string): Promise<void> {
        const sid = sessionId ?? this.sessionId;
        if (!sid) throw new Error('No active session');
        await this.request('session/set_model', { sessionId: sid, modelId });
    }

    isReady(): boolean {
        return this.initialized && this.proc !== null;
    }

    getSessionId(): string | null {
        return this.sessionId;
    }

    stop(): void {
        if (this.proc) {
            this.stopping = true;
            this.proc.kill();
            this.proc = null;
        }
        this.initialized = false;
        for (const { reject, timeout } of this.pendingRequests.values()) {
            clearTimeout(timeout);
            reject(new Error('Hermes ACP process stopped'));
        }
        this.pendingRequests.clear();
    }
}
