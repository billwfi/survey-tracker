document.addEventListener('DOMContentLoaded', () => {
  const nav = document.getElementById('site-nav');
  if (!nav) return;
  const page = location.pathname.replace(/\/$/, '') || '/index.html';
  const links = [
    { href: '/index.html', label: 'Import' },
    { href: '/reports.html', label: 'Patient Sat' },
  ];
  const linkHtml = links.map(l => {
    const active = page === l.href || (page === '/' && l.href === '/index.html') ? ' active' : '';
    return `<a class="nav-link${active}" href="${l.href}">${l.label}</a>`;
  }).join('');
  nav.innerHTML = `<span class="nav-brand">Reporting</span><nav class="nav-links">${linkHtml}</nav><img src="/medallus-logo.png" alt="Medallus Medical North Dakota" class="nav-logo">`;
});
