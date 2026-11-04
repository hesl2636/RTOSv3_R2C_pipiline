/** Presentation-only navigation and file selection; validation stays in app.js. */
export function setupWorkspace() {
  const input = document.getElementById('file-input');
  const dropzone = document.getElementById('upload-dropzone');
  const filename = document.getElementById('file-name');
  const detail = document.getElementById('file-detail');
  const action = document.getElementById('file-action');

  function describeFile() {
    const file = input.files?.[0];
    dropzone.classList.toggle('has-file', Boolean(file));
    filename.textContent = file?.name ?? '选择 zip 文件，或拖放到这里';
    detail.textContent = file
      ? `${(file.size / 1024).toFixed(1)} KiB · 已选择 · 点击更换文件`
      : '单个 ZIP 文件 · 最大 8 MiB · 仅在内存中校验';
    action.textContent = file ? '更换文件 ↗' : '选择文件 ↗';
  }

  input.addEventListener('change', describeFile);
  let dragDepth = 0;
  dropzone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    dropzone.classList.add('is-dragging');
  });
  dropzone.addEventListener('dragover', (event) => event.preventDefault());
  dropzone.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove('is-dragging');
  });
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('is-dragging');
    const files = event.dataTransfer?.files;
    if (!files?.length) return;
    if (files.length !== 1 || !/\.zip$/i.test(files[0].name)) {
      const status = document.getElementById('upload-status');
      status.textContent = '请选择单个 .zip 文件；当前文件选择未更改。';
      return;
    }
    input.files = files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  const links = [...document.querySelectorAll('.workflow-nav .nav-item')];
  const sections = links.map((link) => document.querySelector(link.hash));
  function updateNavigation() {
    const visible = sections.filter((section) => !section.hidden);
    const atEnd = window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    const current = atEnd ? visible.at(-1) : visible.filter((section) => section.getBoundingClientRect().top <= 160).at(-1) ?? visible[0];
    for (const link of links) {
      const active = link.hash === `#${current.id}`;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }
  let scheduled = false;
  window.addEventListener('scroll', () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      updateNavigation();
    });
  }, { passive: true });
  window.addEventListener('resize', updateNavigation);
  updateNavigation();
}
