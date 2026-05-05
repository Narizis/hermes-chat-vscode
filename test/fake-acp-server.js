#!/usr/bin/env node
// Minimal stand-in for `hermes acp` used by the smoke test.
// Speaks just enough JSON-RPC over stdio to exercise the extension's
// AcpClient: initialize, session/new, session/resume (with the same
// quirk real Hermes has — unknown id silently creates a fresh session
// and omits sessionId from the response), and session/prompt with
// streaming agent_message_chunk updates.

const KNOWN_SESSIONS = new Set();

function send(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
}

function notify(method, params) {
    send({ jsonrpc: '2.0', method, params });
}

function uuid() {
    return 'sess-' + Math.random().toString(36).slice(2, 10);
}

function handle(req) {
    const { id, method, params } = req;
    switch (method) {
        case 'initialize':
            send({
                jsonrpc: '2.0',
                id,
                result: {
                    agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { resume: {} } },
                    agentInfo: { name: 'fake-hermes', version: '0.0.1' },
                    protocolVersion: 1,
                },
            });
            break;
        case 'session/new': {
            const sid = uuid();
            KNOWN_SESSIONS.add(sid);
            send({ jsonrpc: '2.0', id, result: { sessionId: sid } });
            break;
        }
        case 'session/resume': {
            const requested = params?.sessionId;
            if (requested && KNOWN_SESSIONS.has(requested)) {
                send({ jsonrpc: '2.0', id, result: { sessionId: requested } });
            } else {
                // Mirror real Hermes: silently allocate a fresh session and
                // leave sessionId out of the response body.
                const sid = uuid();
                KNOWN_SESSIONS.add(sid);
                send({ jsonrpc: '2.0', id, result: {} });
            }
            break;
        }
        case 'session/prompt': {
            const sid = params?.sessionId;
            if (!sid || !KNOWN_SESSIONS.has(sid)) {
                send({ jsonrpc: '2.0', id, result: { stopReason: 'refusal' } });
                break;
            }
            for (const chunk of ['Hello', ', ', 'world', '!']) {
                notify('session/update', {
                    sessionId: sid,
                    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
                });
            }
            send({
                jsonrpc: '2.0',
                id,
                result: { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 4, totalTokens: 5 } },
            });
            break;
        }
        case 'session/cancel':
            // notification, no response
            break;
        default:
            send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch { /* ignore */ }
    }
});
process.stdin.on('end', () => process.exit(0));
