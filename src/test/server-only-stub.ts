// `server-only` 的作用是讓 client bundle 一旦引入伺服器端模組就建置失敗。
// 在 Vitest 中它會被解析成 browser 條件而拋錯，故於測試環境替換為 no-op。
// 這不會削弱保護：真正的檢查發生在 next build，由 npm run check:no-secrets 驗證。
export {};
