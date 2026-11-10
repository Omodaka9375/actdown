//! WASM C ABI exports (SPEC surfaces 9/10/5/11). The playground embeds this
//! module with no bundler: every export is a flat `extern "C"` function over
//! WASM linear memory, so it runs in any browser with
//! `WebAssembly.instantiate`, no bindgen glue required.
//!
//! Protocol:
//!   1. host allocates input memory with `ad_alloc`, writes the `.ad` text;
//!   2. `ad_parse(ptr, len)` parses and canonicalizes it (0 ok, 1 error);
//!   3. any of `ad_render` / `ad_render_reactive` / `ad_format` / `ad_ast`
//!      fills the output buffer and returns 0, or returns 1 with a message
//!      readable via `ad_err_ptr` / `ad_err_len`;
//!   4. host reads the output buffer via `ad_ptr` / `ad_len`. The buffer is
//!      valid until the next call into this module.

use crate::canonical::{canonicalize, format, print, to_json};
use crate::parse::parse;
use crate::react::render_reactive;
use crate::render::render;
use std::cell::RefCell;
use std::slice;

thread_local! {
    /// Document left by the last successful `ad_parse`.
    static DOC: RefCell<Option<crate::types::Doc>> = const { RefCell::new(None) };
    /// Output of the last successful render/format call.
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    /// Message recorded by the last failing call (cleared on success).
    static ERR: RefCell<Option<String>> = const { RefCell::new(None) };
}

fn set_err(msg: String) -> u32 {
    ERR.with(|err| *err.borrow_mut() = Some(msg));
    1
}

/// Allocate `len` bytes of zeroed scratch memory for the host to fill.
#[no_mangle]
pub extern "C" fn ad_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    let mut buf = Vec::with_capacity(len);
    buf.resize(len, 0);
    Box::into_raw(buf.into_boxed_slice()) as *mut u8
}

/// Free a buffer previously returned by `ad_alloc` (len must match the
/// allocation). Without this every input buffer leaked; the playground
/// calls it after each parse.
#[no_mangle]
pub unsafe extern "C" fn ad_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    unsafe {
        let slice = std::slice::from_raw_parts_mut(ptr, len);
        drop(Box::from_raw(slice));
    }
}

/// Parse the host-written `.ad` text and keep the canonicalized document.
#[no_mangle]
pub unsafe extern "C" fn ad_parse(input: *const u8, len: usize) -> u32 {
    // A null pointer is only valid at len 0 (the empty-input path); a null
    // with a non-zero length would violate from_raw_parts' contract.
    if input.is_null() {
        if len == 0 {
            let result = parse("");
            if !result.diagnostics.is_empty() {
                return set_err("empty input produced diagnostics (unexpected)".into());
            }
            let doc = canonicalize(&result.doc);
            DOC.with(|slot| *slot.borrow_mut() = Some(doc));
            ERR.with(|err| *err.borrow_mut() = None);
            return 0;
        }
        return set_err("null input pointer with non-zero length".into());
    }
    let bytes = unsafe { slice::from_raw_parts(input, len) };
    let input = match std::str::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => return set_err(format!("input is not valid UTF-8: {e}")),
    };
    let result = parse(input);
    if !result.diagnostics.is_empty() {
        let msgs: Vec<String> = result
            .diagnostics
            .iter()
            .map(|d| format!("line {}: {} ({})", d.line, d.message, d.code))
            .collect();
        return set_err(msgs.join("; "));
    }
    let doc = canonicalize(&result.doc);
    DOC.with(|slot| *slot.borrow_mut() = Some(doc));
    ERR.with(|err| *err.borrow_mut() = None);
    0
}

/// Static level-1 HTML of the parsed document.
#[no_mangle]
pub extern "C" fn ad_render() -> u32 {
    let doc = DOC.with(|slot| slot.borrow().clone());
    let Some(doc) = doc else {
        return set_err("no parsed document".into());
    };
    let html = render(&doc);
    OUT.with(|out| {
        out.borrow_mut().clear();
        out.borrow_mut().extend(html.into_bytes());
    });
    ERR.with(|err| *err.borrow_mut() = None);
    0
}

/// Reactive HTML of the parsed document (bindings filled, when/each applied).
#[no_mangle]
pub extern "C" fn ad_render_reactive() -> u32 {
    let doc = DOC.with(|slot| slot.borrow().clone());
    let Some(doc) = doc else {
        return set_err("no parsed document".into());
    };
    match render_reactive(&doc) {
        Ok(html) => {
            OUT.with(|out| {
                out.borrow_mut().clear();
                out.borrow_mut().extend(html.into_bytes());
            });
            ERR.with(|err| *err.borrow_mut() = None);
            0
        }
        Err(e) => set_err(e.to_string()),
    }
}

/// Canonical text of the parsed document (SPEC 9/10).
#[no_mangle]
pub extern "C" fn ad_format() -> u32 {
    let doc = DOC.with(|slot| slot.borrow().clone());
    let Some(doc) = doc else {
        return set_err("no parsed document".into());
    };
    let text = format(&print(&doc));
    OUT.with(|out| {
        out.borrow_mut().clear();
        out.borrow_mut().extend(text.into_bytes());
    });
    ERR.with(|err| *err.borrow_mut() = None);
    0
}

/// JSON AST of the parsed document (SPEC 8).
#[no_mangle]
pub extern "C" fn ad_ast() -> u32 {
    let doc = DOC.with(|slot| slot.borrow().clone());
    let Some(doc) = doc else {
        return set_err("no parsed document".into());
    };
    let json = to_json(&doc);
    OUT.with(|out| {
        out.borrow_mut().clear();
        out.borrow_mut().extend(json.into_bytes());
    });
    ERR.with(|err| *err.borrow_mut() = None);
    0
}

/// Read the output buffer: pointer (null when empty).
#[no_mangle]
pub extern "C" fn ad_ptr() -> *const u8 {
    OUT.with(|out| {
        let borrowed = out.borrow();
        if borrowed.is_empty() {
            std::ptr::null()
        } else {
            borrowed.as_ptr()
        }
    })
}

/// Read the output buffer: length.
#[no_mangle]
pub extern "C" fn ad_len() -> usize {
    OUT.with(|out| out.borrow().len())
}

/// Read the last error message: pointer (null when there is none).
#[no_mangle]
pub extern "C" fn ad_err_ptr() -> *const u8 {
    ERR.with(|err| {
        let borrowed = err.borrow();
        match borrowed.as_ref() {
            Some(msg) => msg.as_ptr(),
            None => std::ptr::null(),
        }
    })
}

/// Read the last error message: length (0 when there is none).
#[no_mangle]
pub extern "C" fn ad_err_len() -> usize {
    ERR.with(|err| err.borrow().as_ref().map_or(0, |m| m.len()))
}
