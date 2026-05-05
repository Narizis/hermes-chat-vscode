#!/usr/bin/env node
// Smoke test for AcpClient against a fake ACP server.
// Verifies the JSON-RPC contract end-to-end and guards against the
// resumeSession bug where Hermes silently allocates a new session
// when the requested id is unknown (response omits sessionId).

require('./vscode-shim');
const path = require('path');
const assert = require('assert');

const { AcpClient } = require('../out/acp-client.js');

const FAKE_SERVER = path.join(__dirname, 'fake-acp-server.js');

let failures = 0;
async function test(name, fn) {
    process.stdout.write('  ' + name + ' ... ');
    try {
        await fn();
        console.log('ok');
    } catch (err) {
        failures += 1;
        console.log('FAIL');
        console.error('    ' + (err && err.stack ? err.stack : String(err)));
    }
}

function makeClient() {
    return new AcpClient(process.execPath + ' ' + FAKE_SERVER, 5000, 5000);
}

// AcpClient's spawn() takes a single program path; we need to spawn `node fake-acp-server.js`.
// Subclass to override start() with a node-based spawn.
const { spawn } = require('child_process');
const { AcpClient: BaseAcpClient } = require('../out/acp-client.js');

class TestAcpClient extends BaseAcpClient {
    async start() {
        if (this.proc) return;
        this.stopping = false;
        this.proc = spawn(process.execPath, [FAKE_SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.proc.stdout.on('data', (d) => { this.buffer += d.toString('utf8'); this.processBuffer(); });
        this.proc.stderr.on('data', (d) => this.emit('log', d.toString('utf8')));
        this.proc.on('exit', (code) => {
            if (!this.stopping) this.emit('exit', code);
            this.proc = null;
            this.initialized = false;
            for (const { reject, timeout } of this.pendingRequests.values()) {
                clearTimeout(timeout);
                reject(new Error('exited ' + code));
            }
            this.pendingRequests.clear();
        });
        await this.initialize();
    }
}

(async () => {
    console.log('AcpClient smoke tests');

    await test('initialize succeeds', async () => {
        const c = new TestAcpClient('node', 5000, 5000);
        await c.start();
        assert.strictEqual(c.isReady(), true);
        c.stop();
    });

    await test('newSession returns a sessionId', async () => {
        const c = new TestAcpClient('node', 5000, 5000);
        await c.start();
        const sid = await c.newSession('/tmp');
        assert.ok(sid && typeof sid === 'string', 'expected non-empty sessionId, got ' + sid);
        c.stop();
    });

    await test('prompt streams agent_message_chunk and resolves end_turn', async () => {
        const c = new TestAcpClient('node', 5000, 5000);
        const chunks = [];
        c.on('sessionUpdate', (evt) => {
            if (evt.update && evt.update.sessionUpdate === 'agent_message_chunk') {
                chunks.push(evt.update.content.text);
            }
        });
        await c.start();
        await c.newSession('/tmp');
        const result = await c.prompt('hi');
        assert.strictEqual(result.stopReason, 'end_turn');
        assert.strictEqual(chunks.join(''), 'Hello, world!', 'streamed text mismatch: ' + JSON.stringify(chunks));
        c.stop();
    });

    await test('resumeSession returns false when server allocates a new session (regression: blank reply bug)', async () => {
        const c = new TestAcpClient('node', 5000, 5000);
        await c.start();
        const ok = await c.resumeSession('definitely-not-a-real-session-id', '/tmp');
        assert.strictEqual(ok, false, 'resumeSession must reject silent fallback to a fresh session');
        c.stop();
    });

    await test('resumeSession returns true when server confirms the requested id', async () => {
        const c = new TestAcpClient('node', 5000, 5000);
        await c.start();
        const sid = await c.newSession('/tmp');
        const ok = await c.resumeSession(sid, '/tmp');
        assert.strictEqual(ok, true);
        c.stop();
    });

    if (failures > 0) {
        console.error('\n' + failures + ' test(s) failed');
        process.exit(1);
    }
    console.log('\nAll tests passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
