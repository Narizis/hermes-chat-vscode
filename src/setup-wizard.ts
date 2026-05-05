import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

const INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash';

interface ProviderDef {
    id: string;             // hermes provider id (model.provider value)
    label: string;
    envKey: string | null;  // env var to write to ~/.hermes/.env (null = no key)
    defaultModel: string;
    keyHelp: string;
    keyUrl?: string;
    tier: 1 | 2;            // 1 = top-level grid, 2 = "more" dropdown
    testUrl?: string;       // if set, GET this with auth to validate the key
    testAuth?: 'bearer' | 'x-api-key' | 'anthropic' | 'query'; // how to attach the key
}

const PROVIDERS: ProviderDef[] = [
    // Tier 1 — main grid
    { id: 'anthropic',   label: 'Anthropic',                            envKey: 'ANTHROPIC_API_KEY',    defaultModel: '',     keyHelp: 'sk-ant-…',  keyUrl: 'https://console.anthropic.com/settings/keys', tier: 1, testUrl: 'https://api.anthropic.com/v1/models', testAuth: 'anthropic' },
    { id: 'openrouter',  label: 'OpenRouter',                           envKey: 'OPENROUTER_API_KEY',   defaultModel: '',     keyHelp: 'sk-or-…',   keyUrl: 'https://openrouter.ai/keys', tier: 1, testUrl: 'https://openrouter.ai/api/v1/models', testAuth: 'bearer' },
    { id: 'openai-codex',label: 'OpenAI',                               envKey: 'OPENAI_API_KEY',       defaultModel: '',                       keyHelp: 'sk-…',      keyUrl: 'https://platform.openai.com/api-keys', tier: 1, testUrl: 'https://api.openai.com/v1/models', testAuth: 'bearer' },
    { id: 'gemini',      label: 'Google Gemini',                        envKey: 'GEMINI_API_KEY',       defaultModel: '',                keyHelp: 'AIza…',     keyUrl: 'https://aistudio.google.com/apikey', tier: 1, testUrl: 'https://generativelanguage.googleapis.com/v1beta/models', testAuth: 'query' },
    { id: 'nous',        label: 'Nous Portal',                          envKey: null,                   defaultModel: '',                 keyHelp: '',          keyUrl: 'https://hermes-agent.nousresearch.com', tier: 1 },
    { id: 'custom',      label: 'Ollama / LM Studio / LiteLLM / vLLM / custom',  envKey: null,                   defaultModel: '',                      keyHelp: '',          tier: 1 },
    // Tier 2 — "more providers" dropdown
    { id: 'kimi-coding',  label: 'Kimi (Moonshot, Global)', envKey: 'KIMI_API_KEY',         defaultModel: '',  keyHelp: 'sk-…',      keyUrl: 'https://platform.moonshot.ai/console/api-keys', tier: 2, testUrl: 'https://api.moonshot.ai/v1/models', testAuth: 'bearer' },
    { id: 'kimi-coding-cn', label: 'Kimi (Moonshot, China)', envKey: 'KIMI_CN_API_KEY',     defaultModel: '',  keyHelp: 'sk-…',      keyUrl: 'https://platform.moonshot.cn/console/api-keys', tier: 2, testUrl: 'https://api.moonshot.cn/v1/models', testAuth: 'bearer' },
    { id: 'zai',          label: 'z.ai (GLM)',              envKey: 'GLM_API_KEY',          defaultModel: '',               keyHelp: 'GLM API key', keyUrl: 'https://z.ai/manage-apikey/apikey-list', tier: 2, testUrl: 'https://api.z.ai/api/paas/v4/models', testAuth: 'bearer' },
    { id: 'minimax',      label: 'MiniMax',                 envKey: 'MINIMAX_API_KEY',      defaultModel: '',            keyHelp: 'MiniMax key', keyUrl: 'https://www.minimax.io/platform/user-center/basic-information/interface-key', tier: 2 },
    { id: 'minimax-cn',   label: 'MiniMax (China)',         envKey: 'MINIMAX_CN_API_KEY',   defaultModel: '',            keyHelp: 'MiniMax CN key', keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', tier: 2 },
    { id: 'nvidia',       label: 'NVIDIA NIM',              envKey: 'NVIDIA_API_KEY',       defaultModel: '', keyHelp: 'nvapi-…', keyUrl: 'https://build.nvidia.com/', tier: 2, testUrl: 'https://integrate.api.nvidia.com/v1/models', testAuth: 'bearer' },
    { id: 'huggingface',  label: 'Hugging Face Inference',  envKey: 'HF_TOKEN',             defaultModel: '', keyHelp: 'hf_…', keyUrl: 'https://huggingface.co/settings/tokens', tier: 2, testUrl: 'https://huggingface.co/api/whoami-v2', testAuth: 'bearer' },
    { id: 'xiaomi',       label: 'Xiaomi MiMo',             envKey: 'XIAOMI_API_KEY',       defaultModel: '',            keyHelp: 'Xiaomi API key', tier: 2 },
    { id: 'arcee',        label: 'Arcee AI',                envKey: 'ARCEEAI_API_KEY',      defaultModel: '',         keyHelp: 'Arcee key',  keyUrl: 'https://www.arcee.ai/', tier: 2 },
    { id: 'ollama-cloud', label: 'Ollama Cloud',            envKey: 'OLLAMA_API_KEY',       defaultModel: '',          keyHelp: 'Ollama Cloud key', keyUrl: 'https://ollama.com/settings/keys', tier: 2, testUrl: 'https://ollama.com/api/tags', testAuth: 'bearer' },
    { id: 'kilocode',     label: 'KiloCode',                envKey: 'KILOCODE_API_KEY',     defaultModel: '',      keyHelp: 'KiloCode key', tier: 2 },
    { id: 'ai-gateway',   label: 'Vercel AI Gateway',       envKey: 'AI_GATEWAY_API_KEY',   defaultModel: '', keyHelp: 'Vercel AI Gateway key', keyUrl: 'https://vercel.com/dashboard/ai/gateway', tier: 2, testUrl: 'https://ai-gateway.vercel.sh/v1/models', testAuth: 'bearer' },
    { id: 'lmstudio',     label: 'LM Studio',               envKey: null,                   defaultModel: '', keyHelp: '', tier: 2, testUrl: 'http://127.0.0.1:1234/v1/models' },
    { id: 'copilot',      label: 'GitHub Copilot',          envKey: 'GITHUB_TOKEN',         defaultModel: '',                keyHelp: 'GitHub PAT', keyUrl: 'https://github.com/settings/tokens', tier: 2, testUrl: 'https://api.github.com/user', testAuth: 'bearer' },
];

function getHermesPath(): string {
    return vscode.workspace.getConfiguration('hermes-chat').get('hermesPath', 'hermes');
}

function hermesHome(): string {
    return process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
}

function configPath(): string { return path.join(hermesHome(), 'config.yaml'); }
function envPath(): string { return path.join(hermesHome(), '.env'); }

interface ConfigState {
    providerConfigured: boolean;
    activeProvider: string | null;
    activeModel: string | null;
}

function readConfigState(): ConfigState {
    try {
        if (!fs.existsSync(configPath())) return { providerConfigured: false, activeProvider: null, activeModel: null };
        const raw = fs.readFileSync(configPath(), 'utf8');
        const doc = yaml.load(raw) as Record<string, unknown> | null;
        const model = (doc?.model ?? {}) as Record<string, unknown>;
        const provider = typeof model.provider === 'string' ? model.provider : null;
        const def = typeof model.default === 'string' ? model.default : (typeof model.model === 'string' ? model.model : null);
        // "auto" with no env keys = not really configured
        const envOk = hasAnyKnownKey();
        const configured = !!provider && provider !== 'auto' && (provider === 'custom' || envOk);
        return { providerConfigured: configured, activeProvider: provider, activeModel: def };
    } catch {
        return { providerConfigured: false, activeProvider: null, activeModel: null };
    }
}

function hasAnyKnownKey(): boolean {
    if (!fs.existsSync(envPath())) return false;
    const raw = fs.readFileSync(envPath(), 'utf8');
    return PROVIDERS.some((p) => p.envKey && new RegExp(`^${p.envKey}=\\S`, 'm').test(raw));
}

function readEnvValue(key: string): string | null {
    if (!fs.existsSync(envPath())) return null;
    const raw = fs.readFileSync(envPath(), 'utf8');
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(raw);
    if (!m) return null;
    return m[1].trim().replace(/^['"]|['"]$/g, '');
}

interface TestResult { ok: boolean; message: string; }

async function testProviderKey(provider: ProviderDef): Promise<TestResult> {
    if (!provider.testUrl) return { ok: false, message: 'No test endpoint defined for this provider — saved but unverified.' };

    let url = provider.testUrl;
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    let key: string | null = null;
    if (provider.envKey) {
        key = readEnvValue(provider.envKey);
        if (!key) return { ok: false, message: `${provider.envKey} not found in ~/.hermes/.env` };
    }

    if (provider.testAuth === 'bearer' && key) headers['Authorization'] = `Bearer ${key}`;
    else if (provider.testAuth === 'x-api-key' && key) headers['x-api-key'] = key;
    else if (provider.testAuth === 'anthropic' && key) {
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
    } else if (provider.testAuth === 'query' && key) {
        url = `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        if (res.status === 200) return { ok: true, message: `Key works ✓ (${provider.label} responded 200)` };
        if (res.status === 401 || res.status === 403) return { ok: false, message: `Key rejected (HTTP ${res.status}). Double-check your key and try again.` };
        const body = (await res.text()).slice(0, 200);
        return { ok: false, message: `HTTP ${res.status}: ${body}` };
    } catch (err: unknown) {
        const e = err as { name?: string; message?: string };
        if (e?.name === 'AbortError') return { ok: false, message: 'Request timed out after 10s. Check your network or the endpoint URL.' };
        return { ok: false, message: `Network error: ${e?.message || String(err)}` };
    } finally {
        clearTimeout(timer);
    }
}

function checkInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
        const proc = spawn(getHermesPath(), ['version'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let settled = false;
        const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(t); resolve(ok); };
        const t = setTimeout(() => { proc.kill(); finish(false); }, 5000);
        proc.on('close', (code) => finish(code === 0));
        proc.on('error', () => finish(false));
    });
}

function upsertEnvVar(key: string, value: string): void {
    let raw = '';
    if (fs.existsSync(envPath())) raw = fs.readFileSync(envPath(), 'utf8');
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(raw)) raw = raw.replace(re, `${key}=${value}`);
    else raw = (raw && !raw.endsWith('\n') ? raw + '\n' : raw) + `${key}=${value}\n`;
    fs.mkdirSync(path.dirname(envPath()), { recursive: true });
    fs.writeFileSync(envPath(), raw, { mode: 0o600 });
}

function writeProviderToConfig(providerId: string, model: string): void {
    let doc: Record<string, unknown> = {};
    if (fs.existsSync(configPath())) {
        try {
            doc = (yaml.load(fs.readFileSync(configPath(), 'utf8')) as Record<string, unknown>) || {};
        } catch { doc = {}; }
    }
    const m = (doc.model ?? {}) as Record<string, unknown>;
    m.provider = providerId;
    if (model) m.default = model; else delete m.default;
    if (providerId !== 'custom' && providerId !== 'lmstudio') {
        delete m.base_url;
        delete m.api_mode;
        delete m.api_key;
    }
    doc.model = m;
    if (!doc.providers) doc.providers = {};
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), yaml.dump(doc, { lineWidth: 100 }));
}

export class SetupWizard {
    private static panel: vscode.WebviewPanel | undefined;
    private static pollTimer: NodeJS.Timeout | undefined;

    static async show(context: vscode.ExtensionContext): Promise<void> {
        if (this.panel) { this.panel.reveal(vscode.ViewColumn.Active); return; }

        const installed = await checkInstalled();
        const cfg = installed ? readConfigState() : { providerConfigured: false, activeProvider: null, activeModel: null };

        this.panel = vscode.window.createWebviewPanel(
            'hermes-chat.setup',
            'Hermes Setup',
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        this.panel.webview.html = this.html(installed, cfg);

        this.panel.webview.onDidReceiveMessage(async (msg: { type: string; providerId?: string }) => {
            switch (msg.type) {
                case 'install': await this.handleInstall(); break;
                case 'copyInstall': await this.handleCopyInstall(); break;
                case 'checkInstall': await this.handleCheckInstall(); break;
                case 'pickProvider': await this.handlePickProvider(msg.providerId!); break;
                case 'testKey': await this.handleTestKey(); break;
                case 'advancedSetup': await this.handleAdvanced(); break;
                case 'finish': await this.handleFinish(context); break;
                case 'openWslDocs': await vscode.env.openExternal(vscode.Uri.parse('https://learn.microsoft.com/windows/wsl/install')); break;
                case 'openTermuxDocs': await vscode.env.openExternal(vscode.Uri.parse('https://hermes-agent.nousresearch.com/docs/getting-started/termux')); break;
            }
        });
        this.panel.onDidDispose(() => {
            if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
            this.panel = undefined;
        });
    }

    static async maybeShowOnActivate(context: vscode.ExtensionContext): Promise<void> {
        if (context.globalState.get<boolean>('hermes-chat.setupCompleted', false)) return;
        const installed = await checkInstalled();
        if (installed && readConfigState().providerConfigured) {
            await context.globalState.update('hermes-chat.setupCompleted', true);
            return;
        }
        await this.show(context);
    }

    private static post(msg: unknown): void { this.panel?.webview.postMessage(msg); }

    private static async handleInstall(): Promise<void> {
        if (process.platform === 'win32') { this.post({ type: 'showWindowsHelp' }); return; }
        const term = vscode.window.createTerminal({ name: 'Hermes Install' });
        term.show();
        term.sendText(INSTALL_CMD);
        this.post({ type: 'installing' });
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = setInterval(async () => {
            if (await checkInstalled()) {
                if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
                this.post({ type: 'installed', cfg: readConfigState() });
            }
        }, 3000);
    }

    private static async handleCopyInstall(): Promise<void> {
        await vscode.env.clipboard.writeText(INSTALL_CMD);
        this.post({ type: 'copied' });
    }

    private static async handleCheckInstall(): Promise<void> {
        const ok = await checkInstalled();
        if (ok) this.post({ type: 'installed', cfg: readConfigState() });
        else this.post({ type: 'notInstalled' });
    }

    private static async handlePickProvider(providerId: string): Promise<void> {
        const def = PROVIDERS.find((p) => p.id === providerId);
        if (!def) return;

        if (def.envKey) {
            const key = await vscode.window.showInputBox({
                prompt: `Paste your ${def.label} API key`,
                placeHolder: def.keyHelp,
                password: true,
                ignoreFocusOut: true,
                validateInput: (v) => v.trim().length < 8 ? 'That looks too short for an API key' : null,
            });
            if (!key) {
                if (def.keyUrl) {
                    const choice = await vscode.window.showInformationMessage(
                        `Need a ${def.label} key?`, 'Get one', 'Cancel',
                    );
                    if (choice === 'Get one') await vscode.env.openExternal(vscode.Uri.parse(def.keyUrl));
                }
                this.post({ type: 'providerCancelled' });
                return;
            }
            try { upsertEnvVar(def.envKey, key.trim()); }
            catch (err) {
                this.post({ type: 'providerError', error: err instanceof Error ? err.message : String(err) });
                return;
            }
        }

        try { writeProviderToConfig(def.id, def.defaultModel); }
        catch (err) {
            this.post({ type: 'providerError', error: err instanceof Error ? err.message : String(err) });
            return;
        }

        this.post({ type: 'providerSaved', cfg: readConfigState() });
    }

    private static async handleAdvanced(): Promise<void> {
        const term = vscode.window.createTerminal({ name: 'Hermes Setup' });
        term.show();
        term.sendText(`${getHermesPath()} setup`);
    }

    private static async handleTestKey(): Promise<void> {
        const cfg = readConfigState();
        if (!cfg.activeProvider) { this.post({ type: 'testResult', ok: false, message: 'No provider configured yet. Pick one above first.' }); return; }
        const def = PROVIDERS.find((p) => p.id === cfg.activeProvider);
        if (!def) { this.post({ type: 'testResult', ok: false, message: `Unknown provider: ${cfg.activeProvider}. Hermes will still try to use it.` }); return; }
        this.post({ type: 'testStarted' });
        const result = await testProviderKey(def);
        this.post({ type: 'testResult', ...result });
    }

    private static async handleFinish(context: vscode.ExtensionContext): Promise<void> {
        await context.globalState.update('hermes-chat.setupCompleted', true);
        this.panel?.dispose();
        await vscode.commands.executeCommand('hermes-chat.chatView.focus');
    }

    private static html(installed: boolean, cfg: ConfigState): string {
        const isWindows = process.platform === 'win32';
        const providersJson = JSON.stringify(PROVIDERS);
        return /* html */ `<!doctype html>
<html><head><meta charset="utf-8" /><style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 32px 40px; max-width: 760px; margin: 0 auto; line-height: 1.55; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--vscode-descriptionForeground); margin-bottom: 28px; }
.step { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 20px 22px; margin-bottom: 16px; opacity: 0.55; transition: opacity 0.2s; }
.step.active { opacity: 1; border-color: var(--vscode-focusBorder); }
.step.done { opacity: 1; }
.step h2 { margin: 0 0 8px; font-size: 15px; display: flex; align-items: center; gap: 8px; }
.badge { display: inline-block; width: 22px; height: 22px; border-radius: 50%; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); text-align: center; line-height: 22px; font-size: 12px; font-weight: 600; }
.step.done .badge { background: var(--vscode-testing-iconPassed); color: white; }
.step p { margin: 6px 0 12px; color: var(--vscode-descriptionForeground); }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px; margin-right: 8px; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.status { margin-top: 10px; font-size: 12px; color: var(--vscode-descriptionForeground); min-height: 16px; }
.status.ok { color: var(--vscode-testing-iconPassed); }
.status.err { color: var(--vscode-errorForeground); }
details { margin-top: 12px; font-size: 12px; }
summary { cursor: pointer; color: var(--vscode-textLink-foreground); }
pre { background: var(--vscode-textCodeBlock-background); padding: 10px 12px; border-radius: 4px; font-size: 11px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
.windows-help { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); padding: 10px 14px; margin-top: 12px; font-size: 12px; display: none; }
.windows-help.show { display: block; }
.providers { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 6px; }
.provider-card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 14px; cursor: pointer; transition: border-color 0.15s, background 0.15s; background: transparent; text-align: left; color: inherit; font-size: 13px; font-family: inherit; }
.provider-card:hover:not(:disabled) { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
.provider-card .name { font-weight: 600; margin-bottom: 2px; }
.provider-card .hint { font-size: 11px; color: var(--vscode-descriptionForeground); }
.provider-card.active-provider { border-color: var(--vscode-testing-iconPassed); }
</style></head><body>
<h1>Welcome to Hermes Agent Chat</h1>
<div class="sub">A couple of quick steps and you'll be chatting with Hermes inside VS Code.</div>

<div class="step ${installed ? 'done' : 'active'}" id="step-install">
  <h2><span class="badge">1</span> Install Hermes CLI</h2>
  <p>Hermes runs locally. We'll launch the installer in your terminal.</p>
  <button id="btn-install">Install Hermes</button>
  <button id="btn-copy" class="secondary">Copy command</button>
  <button id="btn-check" class="secondary">I've already installed</button>
  <div class="status${installed ? ' ok' : ''}" id="status-install">${installed ? 'Hermes detected.' : ''}</div>
  <div class="windows-help" id="windows-help">Native Windows isn't supported. Install <a href="#" id="link-wsl">WSL2</a> first, then reopen VS Code from inside your WSL distro.</div>
  <details><summary>Other platforms / manual install</summary>
    <pre>${INSTALL_CMD}</pre>
    <div>Termux (Android): see <a href="#" id="link-termux">the Termux guide</a>.</div>
  </details>
</div>

<div class="step ${cfg.providerConfigured ? 'done' : (installed ? 'active' : '')}" id="step-provider">
  <h2><span class="badge">2</span> Pick a model provider</h2>
  <p>Choose where Hermes should send requests. Your API key is stored locally in <code>~/.hermes/.env</code>.</p>
  <div class="providers" id="providers"></div>
  <details style="margin-top:14px"><summary>More providers (Kimi, GLM, MiniMax, NVIDIA, …)</summary>
    <div style="display:flex; gap:8px; align-items:center; margin-top:10px">
      <select id="more-select" style="flex:1; padding:6px 8px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:4px;">
        <option value="">Select a provider…</option>
      </select>
      <button id="btn-more-pick">Use this provider</button>
    </div>
  </details>
  <div class="status${cfg.providerConfigured ? ' ok' : ''}" id="status-provider">${cfg.providerConfigured ? `Configured: ${cfg.activeProvider}${cfg.activeModel ? ' → ' + cfg.activeModel : ' (model: auto)'}` : ''}</div>
  <div style="margin-top:6px"><button id="btn-test" class="secondary" ${cfg.providerConfigured ? '' : 'disabled'}>Test connection</button></div>
  <details style="margin-top:8px"><summary>Advanced (multi-provider, custom endpoints, tools)</summary>
    <p style="margin-top:8px">For full configuration (multiple providers at once, MCP servers, tool toggles), run Hermes's own setup wizard in a terminal:</p>
    <button id="btn-advanced" class="secondary">Run hermes setup in terminal</button>
  </details>
</div>

<div class="step ${cfg.providerConfigured ? 'active' : ''}" id="step-finish">
  <h2><span class="badge">3</span> Start chatting</h2>
  <p>You're ready to go.</p>
  <button id="btn-finish" ${cfg.providerConfigured ? '' : 'disabled'}>Open Hermes Chat</button>
</div>

<script>
const vscode = acquireVsCodeApi();
const PROVIDERS = ${providersJson};
const isWindows = ${isWindows};
let installed = ${installed};
let providerConfigured = ${cfg.providerConfigured};
let activeProviderId = ${JSON.stringify(cfg.activeProvider)};

const stepInstall = document.getElementById('step-install');
const stepProvider = document.getElementById('step-provider');
const stepFinish = document.getElementById('step-finish');
const statusInstall = document.getElementById('status-install');
const statusProvider = document.getElementById('status-provider');
const winHelp = document.getElementById('windows-help');
const providersEl = document.getElementById('providers');
const btnFinish = document.getElementById('btn-finish');

function setActive(step) {
  for (const el of [stepInstall, stepProvider, stepFinish]) el.classList.remove('active');
  if (step === 'install') stepInstall.classList.add('active');
  if (step === 'provider') stepProvider.classList.add('active');
  if (step === 'finish') stepFinish.classList.add('active');
}

function renderProviders() {
  providersEl.innerHTML = '';
  for (const p of PROVIDERS.filter((x) => x.tier === 1)) {
    const btn = document.createElement('button');
    btn.className = 'provider-card' + (activeProviderId === p.id ? ' active-provider' : '');
    btn.disabled = !installed;
    btn.innerHTML = '<div class="name">' + p.label + '</div><div class="hint">' + (p.envKey ? 'Needs API key' : (p.id === 'nous' ? 'OAuth (hermes auth)' : p.id === 'custom' ? 'OpenAI-compatible endpoint' : 'No key')) + '</div>';
    btn.onclick = () => vscode.postMessage({ type: 'pickProvider', providerId: p.id });
    providersEl.appendChild(btn);
  }
  const sel = document.getElementById('more-select');
  sel.innerHTML = '<option value="">Select a provider…</option>';
  for (const p of PROVIDERS.filter((x) => x.tier === 2)) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label + (p.envKey ? '' : ' (no key)');
    if (activeProviderId === p.id) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.disabled = !installed;
}
renderProviders();

document.getElementById('btn-install').onclick = () => { statusInstall.textContent = 'Launching installer in terminal…'; statusInstall.className = 'status'; vscode.postMessage({ type: 'install' }); };
document.getElementById('btn-copy').onclick = () => vscode.postMessage({ type: 'copyInstall' });
document.getElementById('btn-check').onclick = () => { statusInstall.textContent = 'Checking…'; statusInstall.className = 'status'; vscode.postMessage({ type: 'checkInstall' }); };
document.getElementById('btn-advanced').onclick = () => vscode.postMessage({ type: 'advancedSetup' });
const btnTest = document.getElementById('btn-test');
btnTest.onclick = () => { btnTest.disabled = true; statusProvider.textContent = 'Testing connection…'; statusProvider.className = 'status'; vscode.postMessage({ type: 'testKey' }); };
document.getElementById('btn-more-pick').onclick = () => {
  const sel = document.getElementById('more-select');
  if (sel.value) vscode.postMessage({ type: 'pickProvider', providerId: sel.value });
};
btnFinish.onclick = () => vscode.postMessage({ type: 'finish' });
document.getElementById('link-wsl').onclick = (e) => { e.preventDefault(); vscode.postMessage({ type: 'openWslDocs' }); };
document.getElementById('link-termux').onclick = (e) => { e.preventDefault(); vscode.postMessage({ type: 'openTermuxDocs' }); };

if (isWindows) winHelp.classList.add('show');
if (providerConfigured) setActive('finish'); else if (installed) setActive('provider'); else setActive('install');

window.addEventListener('message', (event) => {
  const m = event.data;
  switch (m.type) {
    case 'installing': statusInstall.textContent = 'Installer running. Waiting for hermes to appear on PATH (auto-checking every 3s)…'; statusInstall.className = 'status'; break;
    case 'copied': statusInstall.textContent = 'Command copied to clipboard.'; statusInstall.className = 'status ok'; break;
    case 'installed':
      installed = true;
      stepInstall.classList.add('done');
      statusInstall.textContent = 'Hermes detected.'; statusInstall.className = 'status ok';
      if (m.cfg && m.cfg.providerConfigured) {
        providerConfigured = true; activeProviderId = m.cfg.activeProvider;
        stepProvider.classList.add('done');
        statusProvider.textContent = 'Configured: ' + m.cfg.activeProvider + (m.cfg.activeModel ? ' → ' + m.cfg.activeModel : ' (model: auto — switch later in the Model panel)');
        statusProvider.className = 'status ok';
        btnFinish.disabled = false;
        setActive('finish');
      } else {
        setActive('provider');
      }
      renderProviders();
      break;
    case 'notInstalled': statusInstall.textContent = 'Hermes not found yet. If you just installed, restart your shell or run "source ~/.zshrc".'; statusInstall.className = 'status err'; break;
    case 'showWindowsHelp': winHelp.classList.add('show'); statusInstall.textContent = 'Windows requires WSL2.'; statusInstall.className = 'status err'; break;
    case 'providerCancelled': statusProvider.textContent = 'Cancelled. Pick a provider when you\\'re ready.'; statusProvider.className = 'status'; break;
    case 'providerError': statusProvider.textContent = 'Failed to save: ' + m.error; statusProvider.className = 'status err'; break;
    case 'providerSaved':
      providerConfigured = true; activeProviderId = m.cfg.activeProvider;
      stepProvider.classList.add('done');
      statusProvider.textContent = 'Configured: ' + m.cfg.activeProvider + (m.cfg.activeModel ? ' → ' + m.cfg.activeModel : ' (model: auto — switch later in the Model panel)');
      statusProvider.className = 'status ok';
      btnFinish.disabled = false;
      btnTest.disabled = false;
      setActive('finish');
      renderProviders();
      break;
    case 'testStarted':
      btnTest.disabled = true;
      break;
    case 'testResult':
      btnTest.disabled = false;
      statusProvider.textContent = m.message;
      statusProvider.className = 'status ' + (m.ok ? 'ok' : 'err');
      break;
  }
});
</script></body></html>`;
    }
}
