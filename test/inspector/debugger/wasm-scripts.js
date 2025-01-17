// Copyright 2016 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Flags: --expose-wasm

InspectorTest.log("Tests how wasm scripts are reported");

let contextGroup = new InspectorTest.ContextGroup();
let sessions = [
  // Main session.
  trackScripts(),
  // Extra session to verify that all inspectors get same messages.
  // See https://bugs.chromium.org/p/v8/issues/detail?id=9725.
  trackScripts(),
  // Another session to check how raw Wasm is reported.
  trackScripts({ supportsWasmDwarf: true }),
];

utils.load('test/mjsunit/wasm/wasm-module-builder.js');

// Add two empty functions. Both should be registered as individual scripts at
// module creation time.
var builder = new WasmModuleBuilder();
builder.addFunction('nopFunction', kSig_v_v).addBody([kExprNop]);
builder.addFunction('main', kSig_v_v)
    .addBody([kExprBlock, kWasmStmt, kExprI32Const, 2, kExprDrop, kExprEnd])
    .exportAs('main');
builder.addCustomSection('.debug_info', []);
var module_bytes = builder.toArray();

function testFunction(bytes) {
  // Compilation triggers registration of wasm scripts.
  new WebAssembly.Module(new Uint8Array(bytes));
}

contextGroup.addScript(testFunction.toString(), 0, 0, 'v8://test/testFunction');
contextGroup.addScript('var module_bytes = ' + JSON.stringify(module_bytes));

InspectorTest.log(
    'Check that each inspector gets two wasm scripts at module creation time.');

sessions[0].Protocol.Runtime
    .evaluate({
      'expression': '//# sourceURL=v8://test/runTestRunction\n' +
          'testFunction(module_bytes)'
    })
    .then(() => (
      // At this point all scripts were parsed.
      // Stop tracking and wait for script sources in each session.
      Promise.all(sessions.map(session => session.getScripts()))
    ))
    .catch(err => {
      InspectorTest.log(err.stack);
    })
    .then(() => InspectorTest.completeTest());

function decodeBase64(base64) {
  const LOOKUP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  const paddingLength = base64.match(/=*$/)[0].length;
  const bytesLength = base64.length * 0.75 - paddingLength;

  let bytes = new Uint8Array(bytesLength);

  for (let i = 0, p = 0; i < base64.length; i += 4, p += 3) {
    let bits = 0;
    for (let j = 0; j < 4; j++) {
      bits <<= 6;
      const c = base64[i + j];
      if (c !== '=') bits |= LOOKUP.indexOf(c);
    }
    for (let j = p + 2; j >= p; j--) {
      if (j < bytesLength) bytes[j] = bits;
      bits >>= 8;
    }
  }

  return bytes;
}

function trackScripts(debuggerParams) {
  let {id: sessionId, Protocol} = contextGroup.connect();
  let scripts = [];

  Protocol.Debugger.enable(debuggerParams);
  Protocol.Debugger.onScriptParsed(handleScriptParsed);

  async function loadScript({url, scriptId}, raw) {
    InspectorTest.log(`Session #${sessionId}: Script #${scripts.length} parsed. URL: ${url}`);
    let scriptSource;
    if (raw) {
      let {result: {bytecode}} = await Protocol.Debugger.getWasmBytecode({scriptId});
      // Binary value is represented as base64 in JSON, decode it.
      bytecode = decodeBase64(bytecode);
      // Check that it can be parsed back to a WebAssembly module.
      let module = new WebAssembly.Module(bytecode);
      scriptSource = `
Raw: ${Array.from(bytecode, b => ('0' + b.toString(16)).slice(-2)).join(' ')}
Imports: [${WebAssembly.Module.imports(module).map(i => `${i.name}: ${i.kind} from "${i.module}"`).join(', ')}]
Exports: [${WebAssembly.Module.exports(module).map(e => `${e.name}: ${e.kind}`).join(', ')}]
      `.trim();
    } else {
      ({result: {scriptSource}} = await Protocol.Debugger.getScriptSource({scriptId}));
    }
    InspectorTest.log(`Session #${sessionId}: Source for ${url}:`);
    InspectorTest.log(scriptSource);
  }

  function handleScriptParsed({params}) {
    if (params.sourceMapURL === "wasm://dwarf") {
      scripts.push(loadScript(params, true));
    } else if (params.url.startsWith("wasm://")) {
      scripts.push(loadScript(params));
    }
  }

  return {
    Protocol,
    getScripts: () => Promise.all(scripts),
  };
}
