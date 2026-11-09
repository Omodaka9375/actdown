export class ParseError extends Error {
  readonly code: string;
  readonly line: number;

  constructor(code: string, message: string, line = 0) {
    super(message);
    this.name = "ParseError";
    this.code = code;
    this.line = line;
  }
}
