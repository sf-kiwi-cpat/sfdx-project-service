/**
 * RFC 9457 Problem Details for HTTP APIs
 * https://www.rfc-editor.org/rfc/rfc9457.html
 */
export interface ProblemDetail {
  status: number;
  title: string;
  detail: string;
  type?: string;
  instance?: string;
}

export function problemDetail(status: number, title: string, detail: string): ProblemDetail {
  return { status, title, detail };
}

export const PROBLEM_JSON = 'application/problem+json';

/**
 * Map thrown errors to HTTP problem details.
 */
export function errorToProblem(err: unknown): ProblemDetail {
  if (err instanceof Error) {
    if (err.message.startsWith('Path escapes project root')) {
      return problemDetail(400, 'Bad Request', err.message);
    }
    if (err.message.startsWith('No file exists')) {
      return problemDetail(404, 'File Not Found', err.message);
    }
    if (err.message.startsWith('Not a file:')) {
      return problemDetail(400, 'Bad Request', err.message);
    }
  }

  const nodeErr = err as NodeJS.ErrnoException;
  if (nodeErr?.code === 'ENOENT') {
    return problemDetail(404, 'File Not Found', `No file exists at path '${nodeErr.path ?? 'unknown'}'`);
  }

  return problemDetail(500, 'Internal Server Error', err instanceof Error ? err.message : String(err));
}
