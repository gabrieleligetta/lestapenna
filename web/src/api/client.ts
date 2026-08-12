/** Same-origin only (a deliberate choice): no base host, no CORS. */
const API_PREFIX = '/api/v1';

export class ApiError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
        this.name = 'ApiError';
    }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${API_PREFIX}${path}`, {
        ...init,
        credentials: 'include', // send the lp_session cookie
        headers: { Accept: 'application/json', ...init?.headers },
    });

    if (!response.ok) {
        let message = response.statusText;
        try {
            const body = await response.json();
            message = body.message ?? message;
        } catch {
            // no JSON body, keep statusText
        }
        throw new ApiError(response.status, message);
    }

    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
}

export function loginUrl(): string {
    return `${API_PREFIX}/auth/discord`;
}

export function logout(): Promise<void> {
    return apiFetch('/auth/logout', { method: 'POST' });
}
