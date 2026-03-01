const KEY = 'qassess-studio-auth-v1';

export interface StoredAuth {
  apiBaseUrl: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  expiresAt: number;
  userEmail: string;
  tenantSlug?: string;
}

export function loadStoredAuth(): StoredAuth | null {
  const raw = window.localStorage.getItem(KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as StoredAuth;
  } catch {
    return null;
  }
}

export function saveStoredAuth(value: StoredAuth): void {
  window.localStorage.setItem(KEY, JSON.stringify(value));
}

export function clearStoredAuth(): void {
  window.localStorage.removeItem(KEY);
}
