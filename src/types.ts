export type Literal =
  | number
  | string
  | boolean
  | null
  | Literal[]
  | { [k: string]: Literal };

/**
 * A deferred expression. Tagged objects share JSON value space with object
 * literals; a literal object `{ kind: "expr", raw: ... }` is pathological
 * and reserved (documented limitation, SPEC 9).
 */
export interface Expr {
  kind: "expr";
  raw: string;
}

export type AttrValue = string | Expr;

export interface ProseNode {
  kind: "prose";
  md: string;
}

export interface BlockNode {
  kind: "block";
  type: string;
  id: string;
  role?: string;
  attrs: Record<string, AttrValue>;
  fields: Record<string, Literal | Expr>;
  body: string | null;
  line: number;
}

export interface ForeignNode {
  kind: "block";
  foreign?: true;
  type: string;
  raw: string;
  line: number;
  diagnostic?: Diagnostic;
}

export type Node = ProseNode | BlockNode | ForeignNode;

export interface Doc {
  ad: "0.1";
  nodes: Node[];
}

export interface Diagnostic {
  code: string;
  message: string;
  line: number;
}

export interface ParseResult {
  doc: Doc;
  diagnostics: Diagnostic[];
}
