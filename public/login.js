document.getElementById('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = document.getElementById('error');
  err.classList.add('hidden');
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usuario: document.getElementById('usuario').value.trim(),
        password: document.getElementById('password').value,
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'No se pudo ingresar');
    location.href = '/';
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  }
});
