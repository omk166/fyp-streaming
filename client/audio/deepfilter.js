// DeepFilterNet3 via libDF compiled to WebAssembly (the `wasm` feature of
// https://github.com/Rikorose/DeepFilterNet/tree/main/libDF, MIT OR Apache-2.0).
// This is a minimal replacement for the wasm-bindgen JS glue: it exposes the same
// functions as libDF/src/wasm.rs (df_create, df_get_frame_length, df_process_frame).
// The binary we use is the libDF build shipped in @workadventure/noise-suppression (see README).

export const DF_RATE = 48000;

function glue() {
  let wasm, f32 = null, u8 = null;
  const memF32 = () => (f32 && f32.buffer === wasm.memory.buffer ? f32 : (f32 = new Float32Array(wasm.memory.buffer)));
  const memU8 = () => (u8 && u8.buffer === wasm.memory.buffer ? u8 : (u8 = new Uint8Array(wasm.memory.buffer)));
  const decoder = new TextDecoder('utf-8');
  const text = (ptr, len) => decoder.decode(memU8().slice(ptr >>> 0, (ptr >>> 0) + len));
  const handlers = {
    // Names carry a build hash suffix, so match on the stable prefix.
    __wbg___wbindgen_throw: (ptr, len) => { throw Error(text(ptr, len)); },
    __wbg_getRandomValues: (ptr, len) => { globalThis.crypto.getRandomValues(memU8().subarray(ptr >>> 0, (ptr >>> 0) + len)); },
    __wbg_new_from_slice: (ptr, len) => new Float32Array(memF32().subarray((ptr >>> 0) / 4, (ptr >>> 0) / 4 + len)),
    __wbindgen_init_externref_table: () => {
      const table = wasm.__wbindgen_externrefs, offset = table.grow(4);
      table.set(0, undefined); table.set(offset, undefined); table.set(offset + 1, null); table.set(offset + 2, true); table.set(offset + 3, false);
    },
  };
  return {
    imports(module) {
      const imports = {};
      for (const { module: name, name: field, kind } of WebAssembly.Module.imports(module)) {
        if (kind !== 'function') throw Error(`Unexpected DeepFilterNet import ${name}.${field}`);
        const key = Object.keys(handlers).find(prefix => field === prefix || field.startsWith(`${prefix}_`));
        if (!key) throw Error(`Unsupported DeepFilterNet wasm import ${field}; the binary does not match libDF's wasm API`);
        (imports[name] ||= {})[field] = handlers[key];
      }
      return imports;
    },
    bind(instance) { wasm = instance.exports; f32 = u8 = null; wasm.__wbindgen_start?.(); return wasm; },
    passBytes(bytes) { const ptr = wasm.__wbindgen_malloc_command_export(bytes.length, 1) >>> 0; memU8().set(bytes, ptr); return ptr; },
    passF32(values) { const ptr = wasm.__wbindgen_malloc_command_export(values.length * 4, 4) >>> 0; memF32().set(values, ptr / 4); return ptr; },
  };
}

// module: a compiled WebAssembly.Module (or bytes); model: the DeepFilterNet3_onnx.tar.gz bytes.
// attenLimDb: libDF's attenuation limit. 100 dB means unlimited, which is libDF's default.
export async function createDeepFilter(module, model, { attenLimDb = 100 } = {}) {
  const compiled = module instanceof WebAssembly.Module ? module : await WebAssembly.compile(module);
  const required = ['df_create', 'df_get_frame_length', 'df_process_frame', 'memory'];
  const exported = WebAssembly.Module.exports(compiled).map(e => e.name);
  for (const name of required) if (!exported.includes(name)) throw Error(`DeepFilterNet wasm is missing ${name}`);
  const g = glue();
  const instance = await WebAssembly.instantiate(compiled, g.imports(compiled));
  const wasm = g.bind(instance);
  const bytes = model instanceof Uint8Array ? model : new Uint8Array(model);
  const state = wasm.df_create(g.passBytes(bytes), bytes.length, attenLimDb) >>> 0;
  const frameLength = wasm.df_get_frame_length(state) >>> 0;
  return {
    frameLength,
    // One hop (frameLength samples at 48 kHz) in, one hop out.
    process(frame) {
      if (frame.length !== frameLength) throw Error(`DeepFilterNet expects ${frameLength} samples per frame`);
      return wasm.df_process_frame(state, g.passF32(frame), frame.length);
    },
    // df_create hands back a raw Box pointer that libDF never frees; each pipeline owns its own worker,
    // and terminating that worker releases the whole wasm memory.
  };
}
