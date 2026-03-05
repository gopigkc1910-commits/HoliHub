## Deploy on GitHub Pages

This project has:
- Frontend (`happyHoli.html`)
- Backend (`server.js`)

GitHub Pages hosts only static files, so:
- `happyHoli.html` can be hosted on GitHub Pages
- `server.js` must be deployed separately (Render/Railway/Render etc.)

### Steps
1. Push project to GitHub.
2. In repo settings: `Settings > Pages`
3. Source: `Deploy from a branch`
4. Branch: `main` (or `master`), folder: `/ (root)`
5. Save and wait for deployment.
6. Open your Pages URL:
   `https://<your-username>.github.io/<repo-name>/happyHoli.html`

### Backend for music search
Deploy `server.js` on a Node host and copy its URL, then set in `happyHoli.html`:

```js
const BACKEND_BASE_URL = "https://your-backend-url.onrender.com";
