// TDX spike 用腳本（tasks 1.1–1.3）。
// 以 node --env-file=.env.local 執行。絕不輸出任何金鑰內容。
const AUTH_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const API_BASE = "https://tdx.transportdata.tw/api/basic";
export const TOURISM_BASE = "https://tdx.transportdata.tw/api/tourism/service/odata/V2/Tourism";

export async function getToken() {
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.TDX_CLIENT_ID ?? "",
      client_secret: process.env.TDX_CLIENT_SECRET ?? "",
    }),
  });
  if (!res.ok) {
    throw new Error(`auth failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return { token: body.access_token, expiresIn: body.expires_in };
}

export async function tdxGet(token, path, base = API_BASE) {
  const res = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}`, "accept-encoding": "gzip" },
  });
  return { status: res.status, body: res.ok ? await res.json() : await res.text() };
}

if (import.meta.filename === process.argv[1]) {
  const { token, expiresIn } = await getToken();
  console.log(`✓ token acquired (expires_in=${expiresIn}s, length=${token.length})`);

  const probe = await tdxGet(token, "/Attraction?$top=3&$format=JSON", TOURISM_BASE);
  console.log(`Tourism/Attraction -> HTTP ${probe.status}`);
  if (probe.status !== 200) {
    console.log("body:", String(probe.body).slice(0, 400));
    process.exit(1);
  }
  const rows = Array.isArray(probe.body) ? probe.body : (probe.body.value ?? []);
  console.log(`rows: ${rows.length}`);
  console.log("first row keys:", Object.keys(rows[0] ?? {}).join(", "));
}
