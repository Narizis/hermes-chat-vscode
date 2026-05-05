// Inject a minimal `vscode` module so we can require the compiled AcpClient
// from plain Node (no extension host). AcpClient only calls vscode for
// workspace introspection inside fs/read_text_file handlers, which the
// smoke tests don't exercise.
const Module = require('module');
const originalResolve = Module._resolveFilename;
const fakeId = '__vscode_shim__';

const shim = {
    workspace: {
        workspaceFolders: [],
        fs: {
            readFile: async () => { throw new Error('vscode.workspace.fs.readFile not available in smoke test'); },
            writeFile: async () => { throw new Error('vscode.workspace.fs.writeFile not available in smoke test'); },
        },
    },
    Uri: { file: (p) => ({ fsPath: p }) },
};

Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'vscode') return fakeId;
    return originalResolve.call(this, request, parent, ...rest);
};

require.cache[fakeId] = {
    id: fakeId,
    filename: fakeId,
    loaded: true,
    exports: shim,
};
