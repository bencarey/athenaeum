const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig:          ()            => ipcRenderer.invoke('get-config'),
  setLibraryPath:     ()            => ipcRenderer.invoke('set-library-path'),
  pickAndIngest:      ()            => ipcRenderer.invoke('pick-and-ingest'),
  listArticles:       ()            => ipcRenderer.invoke('list-articles'),
  getStats:           ()            => ipcRenderer.invoke('get-stats'),
  readArticleHtml:    (id)          => ipcRenderer.invoke('read-article-html', id),
  articleBase:        (id)          => ipcRenderer.invoke('article-base', id),
  readMeta:           (id)          => ipcRenderer.invoke('read-meta', id),
  updateMeta:         (id, patch)   => ipcRenderer.invoke('update-meta', id, patch),
  addReadTime:        (id, secs)    => ipcRenderer.invoke('add-read-time', id, secs),
  deleteArticle:      (id)          => ipcRenderer.invoke('delete-article', id),
  readAnnotations:    (id)          => ipcRenderer.invoke('read-annotations', id),
  writeAnnotations:   (id, data)    => ipcRenderer.invoke('write-annotations', id, data),
  getAnnotationsMtime:(id)          => ipcRenderer.invoke('get-annotations-mtime', id),
  readQuotes:         ()            => ipcRenderer.invoke('read-quotes'),
  writeQuotes:        (data)        => ipcRenderer.invoke('write-quotes', data),
  revealOriginal:     (id)          => ipcRenderer.invoke('reveal-original', id),
  openExternal:       (url)         => ipcRenderer.invoke('open-external', url),
  onMenu:             (cb)          => ipcRenderer.on('menu', (_, action) => cb(action))
});
