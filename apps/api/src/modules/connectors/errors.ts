export class ConnectorError extends Error {
  constructor(public readonly code: string) { super(code); }
}
