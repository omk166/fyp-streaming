// Disposable test owner; use only a local/test server. Context owns the auth cookies.
export async function createTestRoom(browser, base, label) {
  const context = await browser.newContext();
  const headers = { Origin: new URL(base).origin };
  const signup = await context.request.post(`${base}/api/auth/signup`, { headers, data: {
    name: 'Test room owner', email: `test-${crypto.randomUUID()}@example.test`, password: 'test room owner passphrase',
  } });
  if (signup.status() !== 201) throw Error(`Test owner signup failed: ${signup.status()}`);
  const response = await context.request.post(`${base}/api/rooms`, { headers, data: { name: label.slice(0, 48) } });
  if (response.status() !== 201) throw Error(`Test room creation failed: ${response.status()}`);
  const result = await response.json();
  return { ...result, context, query: `room=${result.room.id}`, fragment: `#invite=${result.invitation}` };
}
