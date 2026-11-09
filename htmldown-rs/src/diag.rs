//! Parse errors (SPEC 15). A parse error demotes the offending block to a
//! foreign block; the document MUST still render.

use std::fmt;

#[derive(Debug, Clone)]
pub struct ParseError {
    pub code: &'static str,
    pub message: String,
    pub line: u32,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {} (line {})", self.code, self.message, self.line)
    }
}

impl std::error::Error for ParseError {}

pub fn err(code: &'static str, message: impl Into<String>, line: u32) -> ParseError {
    ParseError { code, message: message.into(), line }
}
