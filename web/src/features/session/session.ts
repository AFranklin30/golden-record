import { api, ApiError } from '../../api';

export const sessionKey = ['session'] as const;

export type OperatorRole = 'admin' | 'operator';
export type Session = {
  operator_id?: string;
  email: string;
  role?: OperatorRole;
  org_name: string;
};

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function signInProblems(email: string, password: string): string[] {
  const problems: string[] = [];
  if (!EMAIL_SHAPE.test(email.trim())) problems.push('Enter an email address.');
  if (!password) problems.push('Enter a password.');
  return problems;
}

export function signInFailureMessage(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'unauthorized') {
    return 'Those credentials were not accepted.';
  }
  if (error instanceof ApiError && error.kind === 'invalid') {
    return 'Enter an email and a password.';
  }
  if (error instanceof ApiError && error.kind === 'network') {
    return 'The dashboard could not be reached. Check the connection and try again.';
  }
  return 'Sign-in could not be completed. Try again.';
}

export function signIn(email: string, password: string): Promise<Session> {
  return api<Session>('/v1/dashboard/session', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function loadSession(): Promise<Session> {
  return api<Session>('/v1/dashboard/session');
}

export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string') return '/imports';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/sign-in')) return '/imports';
  if (value.includes('://') || value.includes('\\')) return '/imports';
  return value;
}
