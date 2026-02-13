import { describe, it, expect } from 'vitest';
import { errorToProblem } from './errors.js';

describe('errorToProblem', () => {
  it('maps path traversal to 400 Bad Request', () => {
    const problem = errorToProblem(new Error('Path escapes project root: ../../../etc/passwd'));
    expect(problem).toMatchObject({ status: 400, title: 'Bad Request' });
  });

  it('maps "No file exists" to 404 File Not Found', () => {
    const problem = errorToProblem(new Error("No file exists at path 'foo.cls'"));
    expect(problem).toMatchObject({ status: 404, title: 'File Not Found' });
  });

  it('maps "Not a file" to 400 Bad Request', () => {
    const problem = errorToProblem(new Error('Not a file: force-app'));
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
