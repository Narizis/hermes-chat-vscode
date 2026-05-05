import * as vscode from 'vscode';
import { HermesChatViewProvider } from './chat-view-provider';
import { MemoryTreeProvider, SkillsTreeProvider, CronTreeProvider, ModelTreeProvider, UsageTreeProvider } from './panels';
import { spawn } from 'child_process';
import { SetupWizard } from './setup-wizard';

let statusBarItem: vscode.StatusBarItem;

function getHermesPath(): string {
    return vscode.workspace.getConfiguration('hermes-chat').get('hermesPath', 'hermes');
}

function getTimeoutMs(): number {
    const seconds = vscode.workspace.getConfiguration('hermes-chat').get('timeout', 30);
    return Math.max(1, seconds) * 1000;
}

function runHermes(args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const proc = spawn(getHermesPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (code: number) => {
            if (settled) return;
            settled = true;
            clearTimeout(t);
            resolve({ code, stdout, stderr });
        };
        const t = setTimeout(() => { proc.kill(); finish(-1); }, timeoutMs);
        proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
        proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        proc.on('close', (code) => finish(code ?? -1));
        proc.on('error', () => finish(-1));
    });
}

async function checkHermesInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
        const proc = spawn(getHermesPath(), ['version'], { stdio: ['pipe', 'pipe', 'pipe'] });
        let settled = false;
        const finish = (installed: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(installed);
        };

        const timeout = setTimeout(() => {
            proc.kill();
            finish(false);
        }, Math.min(getTimeoutMs(), 10_000));

        proc.on('close', (code) => finish(code === 0));
        proc.on('error', () => finish(false));
    });
}

export async function activate(context: vscode.ExtensionContext) {
    const chatProvider = new HermesChatViewProvider(context);
    const memoryProvider = new MemoryTreeProvider();
    const skillsProvider = new SkillsTreeProvider();
    const cronProvider = new CronTreeProvider();
    const modelProvider = new ModelTreeProvider();
    const usageProvider = new UsageTreeProvider();

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(HermesChatViewProvider.viewType, chatProvider),
        vscode.window.registerTreeDataProvider('hermes-chat.memoryView', memoryProvider),
        vscode.window.registerTreeDataProvider('hermes-chat.skillsView', skillsProvider),
        vscode.window.registerTreeDataProvider('hermes-chat.cronView', cronProvider),
        vscode.window.registerTreeDataProvider('hermes-chat.modelView', modelProvider),
        vscode.window.registerTreeDataProvider('hermes-chat.usageView', usageProvider),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('hermes-chat.newSession', () => chatProvider.newSession()),
        vscode.commands.registerCommand('hermes-chat.openChatPanel', () => chatProvider.openPanel()),
        vscode.commands.registerCommand('hermes-chat.clearChat', () => chatProvider.clearChat()),
        vscode.commands.registerCommand('hermes-chat.refreshMemory', () => memoryProvider.refresh()),
        vscode.commands.registerCommand('hermes-chat.refreshSkills', () => skillsProvider.refresh()),
        vscode.commands.registerCommand('hermes-chat.refreshCron', () => cronProvider.refresh()),
        vscode.commands.registerCommand('hermes-chat.openCronJob', async (job: unknown) => {
            const doc = await vscode.workspace.openTextDocument({
                language: 'json',
                content: JSON.stringify(job, null, 2),
            });
            await vscode.window.showTextDocument(doc, { preview: true });
        }),
        vscode.commands.registerCommand('hermes-chat.createCron', async () => {
            const schedule = await vscode.window.showInputBox({
                prompt: 'Schedule',
                placeHolder: "e.g. '30m', 'every 2h', '0 9 * * *'",
                ignoreFocusOut: true,
                validateInput: (v) => v.trim() ? null : 'Schedule is required',
            });
            if (!schedule) return;

            const promptText = await vscode.window.showInputBox({
                prompt: 'Prompt for the agent (optional)',
                placeHolder: 'e.g. Summarize today\'s GitHub notifications',
                ignoreFocusOut: true,
            });
            if (promptText === undefined) return;

            const name = await vscode.window.showInputBox({
                prompt: 'Job name (optional)',
                ignoreFocusOut: true,
            });
            if (name === undefined) return;

            const args = ['cron', 'create'];
            if (name.trim()) args.push('--name', name.trim());
            args.push(schedule.trim());
            if (promptText.trim()) args.push(promptText.trim());

            const status = vscode.window.setStatusBarMessage('$(sync~spin) Creating cron job...');
            const result = await runHermes(args);
            status.dispose();

            if (result.code === 0) {
                vscode.window.showInformationMessage(`Cron job created.${result.stdout.trim() ? ' ' + result.stdout.trim().split('\n')[0] : ''}`);
                cronProvider.refresh();
            } else {
                const err = (result.stderr || result.stdout || `exit ${result.code}`).trim();
                vscode.window.showErrorMessage(`Failed to create cron job: ${err}`);
            }
        }),
        vscode.commands.registerCommand('hermes-chat.refreshModel', () => modelProvider.refresh()),
        vscode.commands.registerCommand('hermes-chat.refreshUsage', () => usageProvider.refresh()),
        vscode.commands.registerCommand('hermes-chat.runSetup', () => SetupWizard.show(context)),
        vscode.commands.registerCommand('hermes-chat.switchModel', async () => {
            const providers = modelProvider.getProviders();
            const currentProvider = modelProvider.getActiveProvider();
            const currentModel = modelProvider.getActiveModel();

            const providerItems = providers.map((p) => ({
                label: p === currentProvider ? `$(check) ${p}` : p,
                providerId: p,
            }));

            const pickedProvider = await vscode.window.showQuickPick(providerItems, {
                placeHolder: `Provider: ${currentProvider || 'auto'} — select provider`,
            });
            if (!pickedProvider) return;

            const models = modelProvider.getModelsForProvider(pickedProvider.providerId);
            const modelItems = models.map((m) => ({
                label: m === currentModel && pickedProvider.providerId === currentProvider ? `$(check) ${m}` : m,
                modelId: m,
            }));
            modelItems.push({ label: '$(edit) Enter model name manually...', modelId: '__custom__' });

            const pickedModel = await vscode.window.showQuickPick(modelItems, {
                placeHolder: `Provider: ${pickedProvider.providerId} — select a model`,
            });
            if (!pickedModel) return;

            let modelId = pickedModel.modelId;
            if (modelId === '__custom__') {
                const input = await vscode.window.showInputBox({
                    prompt: 'Enter model name (e.g. claude-opus-4.6, gpt-5.4)',
                    value: currentModel || '',
                });
                if (!input) return;
                modelId = input.trim();
            }

            const fullModelId = pickedProvider.providerId !== currentProvider
                ? `${pickedProvider.providerId}/${modelId}`
                : modelId;

            modelProvider.setActiveModel(modelId, pickedProvider.providerId);
            const status = vscode.window.setStatusBarMessage(`$(sync~spin) Switching to ${modelId}...`);

            chatProvider.switchModel(fullModelId).then(
                () => {
                    status.dispose();
                    vscode.window.setStatusBarMessage(`$(check) ${modelId} via ${pickedProvider.providerId}`, 2000);
                },
                (err: unknown) => {
                    status.dispose();
                    if (currentModel && currentProvider) modelProvider.setActiveModel(currentModel, currentProvider);
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Failed to switch model: ${msg}`);
                },
            );
        }),
        vscode.commands.registerCommand('hermes-chat.selectModel', async (provider: string, modelId: string) => {
            const prevProvider = modelProvider.getActiveProvider();
            const prevModel = modelProvider.getActiveModel();
            const fullModelId = provider !== prevProvider
                ? `${provider}/${modelId}`
                : modelId;

            // Optimistic UI: update tree and status immediately
            modelProvider.setActiveModel(modelId, provider);
            const status = vscode.window.setStatusBarMessage(`$(sync~spin) Switching to ${modelId}...`);

            chatProvider.switchModel(fullModelId).then(
                () => {
                    status.dispose();
                    vscode.window.setStatusBarMessage(`$(check) ${modelId} via ${provider}`, 2000);
                },
                (err: unknown) => {
                    status.dispose();
                    if (prevModel && prevProvider) modelProvider.setActiveModel(prevModel, prevProvider);
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Failed to switch model: ${msg}`);
                },
            );
        }),
    );

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    statusBarItem.text = '$(hubot) Hermes';
    statusBarItem.tooltip = 'Hermes Agent';
    statusBarItem.command = 'hermes-chat.chatView.focus';
    context.subscriptions.push(statusBarItem);

    const installed = await checkHermesInstalled();
    if (installed) {
        statusBarItem.text = '$(hubot) Hermes';
        statusBarItem.show();
    } else {
        statusBarItem.text = '$(warning) Hermes not found';
        statusBarItem.show();
    }

    void SetupWizard.maybeShowOnActivate(context);

    context.subscriptions.push({ dispose: () => chatProvider.dispose() });
}

export function deactivate() {
    statusBarItem?.dispose();
}
