const API_BASE = `${import.meta.env.BASE_URL}api`;

let cachedToken: string | null = null;

export async function getApiToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const res = await fetch(`${API_BASE}/auth/token`);
  const data = await res.json();
  cachedToken = data.token;
  return cachedToken!;
}

export async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = await getApiToken();
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      "Authorization": `Bearer ${token}`,
    },
  });
}
