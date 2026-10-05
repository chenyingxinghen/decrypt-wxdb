// preload.js — 通过 contextBridge 暴露最小安全 API，屏蔽实现细节
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wememo', {
  // 高层面向渲染层的意图化接口
  init: () => ipcRenderer.invoke('env:init'),
  // 启动恢复：重新解密（清空解密副本，保留密钥）/ 打开数据目录
  resetData: () => ipcRenderer.invoke('env:reset'),
  openDataDir: () => ipcRenderer.invoke('open:dataDir'),
  listSessions: () => ipcRenderer.invoke('bridge', 'sessions', {}).then(r => r.result || {}),
  getMessages: (username, opts = {}) =>
    ipcRenderer.invoke('bridge', 'messages', { username, ...opts }).then(r => r.result || {}),
  getImage: (username, ts, fileHash, thumb = true) =>
    ipcRenderer.invoke('bridge', 'image', { username, ts, file_hash: fileHash, thumb })
      .then(r => r.result || {}),
  // 灯箱放大取本地原图：wxgf(HEVC) / 高清图 / 无原图
  getOriginalImage: (username, ts, fileHash) =>
    ipcRenderer.invoke('bridge', 'original_image', { username, ts, file_hash: fileHash })
      .then(r => r.result || {}),
  search: (kw) => ipcRenderer.invoke('bridge', 'search', { keyword: kw }).then(r => r.result || {}),
  // 全库消息内容检索（首次调用引擎建索引，之后为内存过滤）
  searchMessages: (kw, opts = {}) =>
    ipcRenderer.invoke('bridge', 'search_messages', { keyword: kw, ...opts }).then(r => r.result || {}),
  // 搜索结果跳转：取目标消息前后上下文
  getContext: (username, sortSeq, id, opts = {}) =>
    ipcRenderer.invoke('bridge', 'context', { username, sort_seq: sortSeq, id, ...opts })
      .then(r => r.result || {}),
  // 上下文视图向下补充更新的消息
  getMessagesAfter: (username, sortSeq, id, limit = 30) =>
    ipcRenderer.invoke('bridge', 'messages_after', { username, sort_seq: sortSeq, id, limit })
      .then(r => r.result || {}),
  getContacts: () => ipcRenderer.invoke('bridge', 'contacts', {}).then(r => r.result || {}),
  getStats: (force = false) =>
    ipcRenderer.invoke('bridge', 'stats', { force }).then(r => r.result || {}),
  getProfile: () => ipcRenderer.invoke('bridge', 'profile', {}).then(r => r.result || {}),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  // 增量同步：微信在线时把新消息重解密进来。syncStatus 廉价（轮询用），syncRun 较慢。
  syncStatus: () => ipcRenderer.invoke('bridge', 'sync_status', {}).then(r => r.result || {}),
  syncRun: () => ipcRenderer.invoke('bridge', 'sync_run', {}).then(r => r.result || {}),
  getMsgCount: (username) =>
    ipcRenderer.invoke('bridge', 'msg_count', { username }).then(r => (r.result || {}).count || 0),
  // 导出（主进程弹目录选择框；all=true 导出全部会话）
  exportChat: (opts) => ipcRenderer.invoke('export:run', opts),
  revealPath: (p) => ipcRenderer.invoke('reveal:path', p),
  openPath: (p) => ipcRenderer.invoke('open:path', p),
  // 窗口控制
  windowAction: (act) => ipcRenderer.invoke('window:action', act),
  // 外部链接（默认浏览器打开；主进程校验协议）
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  // 引擎事件（如解密进度），返回取消订阅函数
  onEvent: (cb) => {
    const listener = (_e, event, data) => cb(event, data);
    ipcRenderer.on('bridge-event', listener);
    return () => ipcRenderer.removeListener('bridge-event', listener);
  },
});
