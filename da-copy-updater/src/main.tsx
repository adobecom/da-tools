import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setToken } from './api/daApi';
import './index.css';
import App from './App';

// Obtain the DA auth token: from the da.live "Nx Shell" SDK when embedded in DA, or from
// VITE_DA_TOKEN when running standalone locally. Same handshake as the other tools here.
async function initToken() {
  const localToken = import.meta.env.VITE_DA_TOKEN;
  if (localToken) {
    setToken(localToken);
    return;
  }
  try {
    const sdkUrl = 'https://da.live/nx/utils/sdk.js';
    const DA_SDK = await Promise.race([
      import(/* @vite-ignore */ sdkUrl),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('SDK load timeout (10s)')), 10000)
      ),
    ]) as { default: Promise<{ token: string }> };
    const sdkData = await Promise.race([
      DA_SDK.default,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Token retrieval timeout (5s)')), 5000)
      ),
    ]) as { token: string };
    if (sdkData?.token) setToken(sdkData.token);
  } catch {
    setToken(null);
  }
}

function main() {
  const container = document.getElementById('root');
  if (!container) return;
  const root = createRoot(container);
  (async () => {
    await initToken();
    root.render(
      <StrictMode>
        <App />
      </StrictMode>
    );
  })();
}

main();
