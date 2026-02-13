import { describe, it, expect } from 'vitest';
import {
  errorToProblem,
  FileNotFoundError,
  NotAFileError,
  PathTraversalError,
  RestrictedPathError,
} from './errors.js';

describe('errorToProblem', () => {
  it('maps RestrictedPathError to 400 Bad Request', () => {
    const problem = errorToProblem(new RestrictedPathError());
    expect(problem).toMatchObject({ status: 400, title: 'Bad Request', detail: 'Access to this path is restricted' });
  });

  it('maps PathTraversalError to 400 Bad Request', () => {
    const problem = errorToProblem(new PathTraversalError('../../../etc/passwd'));
    expect(problem).toMatchObject({ status: 400, title: 'Bad Request' });
    expect(problem.detail).toContain('Path escapes project root');
  });

  it('maps FileNotFoundError to 404 File Not Found', () => {
    const problem = errorToProblem(new FileNotFoundError('foo.cls'));
    expect(problem).toMatchObject({ status: 404, title: 'File Not Found' });
  });

  it('maps NotAFileError to 400 Bad Request', () => {
    const problem = errorToProblem(new NotAFileError('force-app'));
    expect(problem).toMatchObject({ status: 400, title: 'Bad Request' });
  });

  it('maps ENOENT to 404 File Not Found', () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    err.path = '/tmp/foo.cls';
    const problem = errorToProblem(err);
    expect(problem).toMatchObject({ status: 404, title: 'File Not Found' });
  });

  it('maps unknown errors to 500 Internal Server Error', () => {
    const problem = errorToProblem(new Error('Something went wrong'));
    expect(problem).toMatchObject({ status: 500, title: 'Internal Server Error' });
  });
});
