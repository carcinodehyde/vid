// Calls to the local server.

async function request(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
  return body;
}

const json = (method, value) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(value),
});

export const api = {
  loadProject: async () => (await request('/api/project')).project,
  saveProject: (project) => request('/api/project', json('PUT', { project })),
  resetProject: () => request('/api/reset', { method: 'POST' }),
  importPath: async (path) => (await request('/api/import', json('POST', { path }))).media,
  upload: async (file) =>
    (await request(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })).media,
  buildProxy: async (id) => (await request(`/api/proxy/${id}`, { method: 'POST' })).media,
  startExport: async (project) => (await request('/api/export', json('POST', { project }))).job,
  exportStatus: async (id) => (await request(`/api/export/${id}`)).job,
};
