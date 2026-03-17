import { describe, it, expect } from 'vitest';
import {
  DeploymentError,
  errorToProblem,
  FileNotFoundError,
  NotAFileError,
  PathTooLongError,
  PathTraversalError,
  RestrictedPathError,
} from '../../src/errors.js';

describe('errorToProblem', () => {
  it('maps RestrictedPathError to 400 Bad Request', () => {
    const problem = errorToProblem(new RestrictedPathError());
    expect(problem).toMatchObject({
      status: 400,
      title: 'Bad Request',
      detail: 'Access to this path is restricted',
    });
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

  it('maps DeploymentError to 502 Deployment Failed', () => {
    const problem = errorToProblem(new DeploymentError('Component validation error'));
    expect(problem).toMatchObject({
      status: 502,
      title: 'Deployment Failed',
      detail: 'Component validation error',
    });
  });

  it('maps PathTooLongError to 400 Bad Request', () => {
    const problem = errorToProblem(new PathTooLongError(2000));
    expect(problem).toMatchObject({ status: 400, title: 'Bad Request' });
    expect(problem.detail).toContain('exceeds maximum allowed length');
  });

  it('maps ENOENT to 404 File Not Found without leaking path', () => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    err.path = '/tmp/foo.cls';
    const problem = errorToProblem(err);
    expect(problem).toMatchObject({
      status: 404,
      title: 'File Not Found',
      detail: 'File not found',
    });
    expect(problem.detail).not.toContain('/tmp/');
  });

  it('maps ENAMETOOLONG to 400 Bad Request without leaking path', () => {
    const err = new Error(
      "ENAMETOOLONG: name too long, stat '/tmp/sf-qa-project/a/.../file.cls'"
    ) as NodeJS.ErrnoException;
    err.code = 'ENAMETOOLONG';
    err.path = '/tmp/sf-qa-project/a/.../file.cls';
    const problem = errorToProblem(err);
    expect(problem).toMatchObject({
      status: 400,
      title: 'Bad Request',
      detail: 'Path is too long',
    });
    expect(problem.detail).not.toContain('/tmp/');
  });

  it('does not leak path in detail for unrecognized ErrnoException', () => {
    const err = new Error(
      "EPERM: operation not permitted, stat '/etc/passwd'"
    ) as NodeJS.ErrnoException;
    err.code = 'EPERM';
    err.path = '/etc/passwd';
    const problem = errorToProblem(err);
    expect(problem).toMatchObject({
      status: 500,
      title: 'Internal Server Error',
      detail: 'Internal server error',
    });
    expect(problem.detail).not.toContain('/etc/passwd');
  });

  it('maps unknown errors to 500 Internal Server Error', () => {
    const problem = errorToProblem(new Error('Something went wrong'));
    expect(problem).toMatchObject({
      status: 500,
      title: 'Internal Server Error',
      detail: 'Something went wrong',
    });
  });
});
