import { sdk } from "@audius/sdk";

// ── SDK singleton ──────────────────────────────────────────────────────────

let _sdk: ReturnType<typeof sdk> | null = null;

export function getSDK() {
  if (!_sdk) {
    _sdk = sdk({
      appName: "audius-ab",
      apiKey: import.meta.env.VITE_AUDIUS_API_KEY ?? "",
      redirectUri:
        import.meta.env.VITE_AUDIUS_REDIRECT_URI ??
        `${window.location.origin}/oauth-callback`,
    });
  }
  return _sdk;
}
