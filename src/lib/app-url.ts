// The app's public base URL: APP_URL when set (a custom domain), else Render's own RENDER_EXTERNAL_URL, else localhost.
export const appUrl = () => (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000").replace(/\/$/, "");
