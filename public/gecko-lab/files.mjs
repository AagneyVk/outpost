const status = document.querySelector('#status');
const list = document.querySelector('#file-list');
const upload = document.querySelector('#upload');
const directory = navigator.storage.getDirectory()
  .then(root => root.getDirectoryHandle('outpost-browser-files', { create: true }));

async function showFiles() {
  list.replaceChildren();
  const folder = await directory;
  for await (const [name, handle] of folder.entries()) {
    if (handle.kind !== 'file') continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'file-row';
    button.textContent = name;
    button.addEventListener('click', async () => {
      try {
        const url = URL.createObjectURL(await handle.getFile());
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (error) {
        status.textContent = error.message;
      }
    });
    list.append(button);
  }
  status.textContent = list.children.length ? 'Files ready' : 'No files yet';
  document.querySelector('#empty-files').hidden = list.children.length > 0;
}

upload.addEventListener('change', async () => {
  const file = upload.files[0];
  if (!file) return;
  upload.disabled = true;
  try {
    await navigator.locks.request('outpost-browser-files', async () => {
      const folder = await directory;
      try {
        await folder.getFileHandle(file.name);
        throw Error('A file with that name already exists.');
      } catch (error) {
        if (error.name !== 'NotFoundError') throw error;
      }
      const handle = await folder.getFileHandle(file.name, { create: true });
      try {
        await file.stream().pipeTo(await handle.createWritable());
      } catch (error) {
        await folder.removeEntry(file.name).catch(() => {});
        throw error;
      }
    });
    await showFiles();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    upload.value = '';
    upload.disabled = false;
  }
});

showFiles().catch(error => { status.textContent = error.message; });
