export type ApiFailureKind = 'unauthorized' | 'invalid' | 'server' | 'network';

export class ApiError extends Error {
  readonly status: number;
  readonly kind: ApiFailureKind;

  constructor(kind: ApiFailureKind, status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

function kindForStatus(status: number): ApiFailureKind {
  if (status === 401) return 'unauthorized';
  if (status === 429 || status >= 500) return 'server';
  if (status >= 400 && status < 500) return 'invalid';
  return 'server';
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
  } catch {
    throw new ApiError('network', 0, 'The dashboard could not be reached.');
  }
  if (!response.ok) {
    let message = 'The request could not be completed.';
    try {
      const body = await response.json();
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      message = 'The request could not be completed.';
    }
    throw new ApiError(kindForStatus(response.status), response.status, message);
  }
  const type = response.headers.get('content-type') || '';
  if (type.includes('text/csv') || type.includes('text/plain')) {
    return (await response.text()) as T;
  }
  return response.json() as Promise<T>;
}
