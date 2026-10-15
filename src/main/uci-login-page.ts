/**
 * The sign-in page /foh-uci serves, instead of the mixer, when a mappings
 * password is set and the browser has no session. It posts to the same login
 * route the mappings editor uses, so one sign-in covers the UCI, its /qrc
 * relay and the editor. Inline so it needs no extra route or packaged file.
 */
export const UCI_LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #111; color: #eee; font-family: -apple-system, system-ui, sans-serif; }
  form { width: 300px; display: flex; flex-direction: column; gap: 12px; padding: 28px; background: #1c1c1e; border: 1px solid #333; border-radius: 10px; }
  h1 { margin: 0; font-size: 15px; font-weight: 600; }
  input, button { font-size: 16px; padding: 10px; border-radius: 6px; border: 1px solid #444; }
  input { background: #111; color: #eee; }
  button { background: #0a84ff; color: #fff; border: none; cursor: pointer; }
  #err { min-height: 14px; margin: 0; font-size: 12px; color: #ff6961; }
</style>
</head>
<body>
<form id="f">
  <h1>FOH Mixer &mdash; Sign in</h1>
  <input type="password" id="login-password" placeholder="Password" autocomplete="current-password" autofocus>
  <button type="submit">Sign in</button>
  <p id="err"></p>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  try {
    const res = await fetch('/api/mappings/login', {
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ password: document.getElementById('login-password').value }),
    });
    if (res.ok) { location.reload(); return; }
    err.textContent = res.status === 401 ? 'Incorrect password' : 'Sign-in failed (' + res.status + ')';
  } catch (_) {
    err.textContent = 'Could not reach the bridge';
  }
});
</script>
</body>
</html>
`
